// No daemon here: prints the two one-liners that give this machine a public
// https URL, and what to do with it.
console.log(`Give http://localhost:${process.env.PORT ?? 4000} a public URL, then put it in .env as PUBLIC_URL and restart:

  cloudflared tunnel --url http://localhost:${process.env.PORT ?? 4000}     # prints https://<name>.trycloudflare.com
  ngrok http ${process.env.PORT ?? 4000}                                   # prints https://<name>.ngrok-free.app

Then on the back office press "Connect webhooks".`);
