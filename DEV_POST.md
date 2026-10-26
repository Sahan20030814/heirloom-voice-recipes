---
title: "Heirloom: I Built a Recipe Keeper for My Grandfather With Open-Source AI"
tags: devchallenge, hacktoberfest, opensource, ai
---

*This is a submission for the [Hacktoberfest Weekend Challenge: Build for a Friend](https://dev.to/challenges/hacktoberfest).*

## What I Built

<!-- Replace with a real person's name and a true story. This paragraph matters most. -->
My Seeya (grandfather) cooks the best pol sambol in the world and has never written down a single recipe. Ask him how much coconut and he says "enough." So I built **Heirloom**: he talks while he cooks, and Heirloom turns the voice memo into a proper recipe page with his story, allergens, his actual voice playable on the page, and a list of **questions I still need to ask him**.

## Demo

<!-- Add screenshots / short video / link to repo -->

## How It Works

`voice memo → faster-whisper (local) → Gemma via Ollama (local) → JSON recipe → cookbook → printable PDF`

- **FastAPI** backend, plain HTML/CSS/JS frontend (no build step).
- **Grammar-constrained JSON:** Ollama's `format` parameter takes a JSON schema, so even a 4B model returns valid recipes.
- **Don't invent:** the prompt forbids guessing amounts. Vague bits become questions in an "Ask them next time" box. This was my favourite design decision.
- **Cooking mode** shows one big step at a time for flour-covered hands.

## Why Open Innovation Matters Here

- **Privacy:** a grandfather's voice, stories and dietary details never touch a server I don't control.
- **Swappable:** `OLLAMA_MODEL=qwen2.5` and it's a different brain. Whisper size is one variable too, which matters for Sinhala.
- **Free & offline:** it works in the kitchen with no signal and costs nothing, so it can outlive any API pricing page.
- Where a closed approach was worse: <!-- be honest: e.g. Sinhala transcription quality, speed on CPU, what you tried -->.

## What They Said

<!-- Bonus points: hand it over and quote their reaction. -->

## Prize Categories

Best Use of Gemma (open-weight model run locally through Ollama).
