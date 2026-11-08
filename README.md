# TripCircle Planner

A website that asks you about your trip, searches the live web with AI, and builds an itinerary with prices,
booking lead times, best season, and tips from blogs and travellers.

## Run it (2 minutes)
1. Install Node 18 or newer.
2. Get at least one API key:
   - Anthropic (Claude + web search): https://console.anthropic.com
   - Google (Gemini + Google Search): https://aistudio.google.com/apikey
   Using both makes the site ask both AIs and merge their answers.
3. In this folder run:

   macOS/Linux:
   ANTHROPIC_API_KEY=your_key GEMINI_API_KEY=your_key node server.js

   Windows (PowerShell):
   $env:ANTHROPIC_API_KEY="your_key"; $env:GEMINI_API_KEY="your_key"; node server.js

4. Open http://localhost:3000

Optional: ANTHROPIC_MODEL, GEMINI_MODEL, PORT.
Keys stay on the server and are never sent to the browser. Web search costs a little per use
(Claude: about $10 per 1,000 searches).

## How it works
1. You enter destination, days, dates, budget, interests.
2. The AI writes 5 questions specific to that place; you answer what matters.
3. Each AI researches with live web search (prices, booking needs, local blogs, hidden gems).
4. One AI merges the notes into a structured plan. Only URLs that the search actually returned can be cited;
   invented links are dropped. Prices that were not found are shown as "price not found".
