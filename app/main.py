"""
Heirloom backend
Voice memo -> local Whisper (faster-whisper) -> local Gemma via Ollama -> structured family recipe.
Nothing ever leaves your machine.
"""
import importlib.util
import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE = Path(__file__).parent
DATA = Path(os.getenv("DATA_DIR", str(BASE.parent / "data")))  # point at a persistent disk when hosting
AUDIO = DATA / "audio"
AUDIO.mkdir(parents=True, exist_ok=True)
DB = DATA / "recipes.json"

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma3:4b")  # any Ollama model works
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")  # tiny / base / small / medium
DEMO = os.getenv("HEIRLOOM_DEMO") == "1"  # canned responses, for a UI-only preview

app = FastAPI(title="Heirloom")
_lock = threading.Lock()
_whisper = None

SAMPLE_TRANSCRIPT = (
    "Ah okay, so my pol sambol. Your Achchi taught me this when I was about twelve. "
    "You take one fresh coconut, grated, about two cups. Then red onion, small ones, "
    "maybe six or seven, chopped fine. Green chillies, two, but if you want it hot, three. "
    "A spoon of Maldive fish flakes, a good lime, juice of one, and salt, you know, to taste. "
    "The secret is you must rub everything with your fingers, not a spoon, "
    "until the coconut turns a little pink from the chilli powder. Two teaspoons of chilli powder. "
    "Eat it the same day. With hot rice and a bit of dhal, ah, that's heaven. "
    "Don't put it in the fridge, it loses the smell."
)

SAMPLE_RECIPE = {
    "title": "Seeya's Pol Sambol",
    "story": "Achchi taught Seeya this when he was about twelve. The secret is rubbing everything together with your fingers, never a spoon, until the coconut turns a little pink.",
    "serves": "4",
    "time": "15 minutes",
    "ingredients": [
        {"item": "fresh grated coconut", "amount": "2 cups"},
        {"item": "small red onions, finely chopped", "amount": "6-7"},
        {"item": "green chillies", "amount": "2 (3 if you like it hot)"},
        {"item": "chilli powder", "amount": "2 tsp"},
        {"item": "Maldive fish flakes", "amount": "1 tbsp"},
        {"item": "lime", "amount": "juice of 1"},
        {"item": "salt", "amount": "to taste"},
    ],
    "steps": [
        "Add the grated coconut, chopped onions, green chillies, chilli powder and Maldive fish to a bowl.",
        "Rub everything together with your fingers until the coconut turns slightly pink.",
        "Squeeze in the lime juice and add salt to taste. Mix again.",
        "Serve the same day with hot rice and dhal.",
    ],
    "tips": ["Use your fingers, not a spoon.", "Do not refrigerate, it loses its aroma."],
    "tags": ["Sri Lankan", "side dish", "no-cook"],
    "allergens": ["fish (Maldive fish)"],
    "unclear": ["How much Maldive fish exactly? He only said 'a spoon'.", "Is the lime juice added before or after the salt?"],
}

RECIPE_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "story": {"type": "string"},
        "serves": {"type": "string"},
        "time": {"type": "string"},
        "ingredients": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"item": {"type": "string"}, "amount": {"type": "string"}},
                "required": ["item", "amount"],
            },
        },
        "steps": {"type": "array", "items": {"type": "string"}},
        "tips": {"type": "array", "items": {"type": "string"}},
        "tags": {"type": "array", "items": {"type": "string"}},
        "allergens": {"type": "array", "items": {"type": "string"}},
        "unclear": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "story", "ingredients", "steps"],
}


# ---------- helpers ----------
def get_whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel

        _whisper = WhisperModel(WHISPER_MODEL, device="auto", compute_type="int8")
    return _whisper


def load_db() -> list:
    if DB.exists():
        try:
            return json.loads(DB.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
    return []


def save_db(items: list) -> None:
    DB.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def normalise(r: dict) -> dict:
    out = {
        "title": str(r.get("title") or "Untitled recipe"),
        "story": str(r.get("story") or ""),
        "serves": str(r.get("serves") or ""),
        "time": str(r.get("time") or ""),
        "ingredients": [],
        "steps": [str(s) for s in (r.get("steps") or [])],
        "tips": [str(s) for s in (r.get("tips") or [])],
        "tags": [str(s) for s in (r.get("tags") or [])],
        "allergens": [str(s) for s in (r.get("allergens") or [])],
        "unclear": [str(s) for s in (r.get("unclear") or [])],
    }
    for ing in r.get("ingredients") or []:
        if isinstance(ing, dict):
            out["ingredients"].append({"item": str(ing.get("item", "")), "amount": str(ing.get("amount", ""))})
        else:
            out["ingredients"].append({"item": str(ing), "amount": ""})
    return out


# ---------- models ----------
class StructureIn(BaseModel):
    transcript: str
    storyteller: str = "Grandpa"
    output_language: str = "English"


class SaveIn(BaseModel):
    recipe: dict
    storyteller: str = ""
    transcript: str = ""
    language: str = ""
    audio: Optional[str] = None


# ---------- API ----------
@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/status")
def status():
    ollama = {"up": False, "model_ready": False, "model": OLLAMA_MODEL}
    try:
        r = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=2)
        names = [m.get("name", "") for m in r.json().get("models", [])]
        ollama["up"] = True
        ollama["model_ready"] = any(
            n == OLLAMA_MODEL or n == OLLAMA_MODEL + ":latest" or n.startswith(OLLAMA_MODEL + ":") for n in names
        )
    except Exception:
        pass
    return {
        "demo": DEMO,
        "ollama": ollama,
        "whisper": {"installed": importlib.util.find_spec("faster_whisper") is not None, "model": WHISPER_MODEL},
        "sample_transcript": SAMPLE_TRANSCRIPT,
    }


@app.post("/api/transcribe")
def transcribe(audio: UploadFile = File(...)):
    ext = Path(audio.filename or "").suffix.lower() or ".webm"
    if ext not in {".webm", ".wav", ".mp3", ".m4a", ".ogg", ".opus", ".flac", ".aac", ".mp4"}:
        ext = ".webm"
    name = f"{uuid.uuid4().hex[:12]}{ext}"
    path = AUDIO / name
    with open(path, "wb") as f:
        shutil.copyfileobj(audio.file, f)

    if DEMO:
        time.sleep(1.2)
        return {"transcript": SAMPLE_TRANSCRIPT, "language": "en", "duration": 42.0, "audio": name}

    try:
        model = get_whisper()
    except ImportError:
        raise HTTPException(501, "faster-whisper is not installed. Run: pip install faster-whisper")
    segments, info = model.transcribe(str(path), beam_size=5, vad_filter=True)
    text = " ".join(s.text.strip() for s in segments).strip()
    if not text:
        raise HTTPException(422, "I couldn't hear any speech in that recording. Try again a bit closer to the mic.")
    return {"transcript": text, "language": info.language, "duration": round(info.duration, 1), "audio": name}


@app.post("/api/structure")
def structure(body: StructureIn):
    if len(body.transcript.strip()) < 15:
        raise HTTPException(422, "The transcript is too short to make a recipe from.")
    if DEMO:
        time.sleep(1.5)
        return normalise(SAMPLE_RECIPE)

    system = (
        "You are a careful family-recipe archivist. You receive a messy, rambling, spoken voice memo "
        f"in which {body.storyteller} explains how they cook a dish. Turn it into a clean recipe.\n"
        "Rules:\n"
        "- NEVER invent ingredients, quantities, times or steps that were not said. If an amount was not "
        "given, use an empty string for amount.\n"
        "- Keep dish names and special words (e.g. 'pol sambol') in their original language.\n"
        f"- Write all text in: {body.output_language}.\n"
        "- 'story' keeps the personal memories and secrets, warm and short (max 3 sentences), in third person.\n"
        "- 'allergens' lists common allergens present (nuts, fish, gluten, dairy, egg, soy...).\n"
        "- 'unclear' lists short questions to ask the storyteller where the memo was vague or contradictory.\n"
        "- Steps must be short, imperative and in order."
    )
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "format": RECIPE_SCHEMA,
        "options": {"temperature": 0.2},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": f"Voice memo transcript:\n\n{body.transcript.strip()}"},
        ],
    }
    try:
        r = httpx.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=600)
    except httpx.ConnectError:
        raise HTTPException(503, "Ollama isn't running. Start it with `ollama serve`, then try again.")
    if r.status_code == 404:
        raise HTTPException(503, f"Model '{OLLAMA_MODEL}' not found. Run: ollama pull {OLLAMA_MODEL}")
    if r.status_code != 200:
        raise HTTPException(502, f"Ollama error: {r.text[:200]}")
    try:
        return normalise(json.loads(r.json()["message"]["content"]))
    except (KeyError, json.JSONDecodeError):
        raise HTTPException(502, "The model returned something I couldn't parse. Try again, or use a larger model.")


@app.get("/api/recipes")
def list_recipes():
    return sorted(load_db(), key=lambda x: x.get("created", 0), reverse=True)


@app.post("/api/recipes")
def add_recipe(body: SaveIn):
    item = {
        "id": uuid.uuid4().hex[:10],
        "created": int(time.time()),
        "storyteller": body.storyteller,
        "language": body.language,
        "transcript": body.transcript,
        "audio": Path(body.audio).name if body.audio else None,
        "recipe": normalise(body.recipe),
    }
    with _lock:
        items = load_db()
        items.append(item)
        save_db(items)
    return item


@app.delete("/api/recipes/{rid}")
def delete_recipe(rid: str):
    with _lock:
        items = load_db()
        gone = [i for i in items if i["id"] == rid]
        if not gone:
            raise HTTPException(404, "Not found")
        save_db([i for i in items if i["id"] != rid])
    if gone[0].get("audio"):
        (AUDIO / Path(gone[0]["audio"]).name).unlink(missing_ok=True)
    return {"ok": True}


app.mount("/audio", StaticFiles(directory=AUDIO), name="audio")
app.mount("/", StaticFiles(directory=BASE / "static", html=True), name="static")
