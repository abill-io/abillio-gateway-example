# Abillio gateway example

A company's side of an Abillio integration, small enough to read in one sitting:
a freelancer joins through the Abillio popup, the company issues an invoice in
their name, pays it from its wallet, the payout goes out, and webhooks tell the
company what happened. Every call to Abillio is shown on the page as it is made.

## Run it

1. Node 22.12 or newer.
2. `cp .env.example .env` and fill in a **sandbox** key: ask Abillio for the demo
   key, or register a business account on https://new.abillio.dev, open its
   sandbox twin and create an API key there.
3. `npm install && npm start`, then open http://localhost:4000.

## Chapters

(written in Task 10)
