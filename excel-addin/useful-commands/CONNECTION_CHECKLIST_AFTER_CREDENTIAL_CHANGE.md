# Connection Checklist After Changing NetSuite Credentials

If the add-in shows "Connected to 589861" (or another old account) and formulas return N/A or features don't work, the request chain is broken or pointing at the wrong backend. Follow this order.

---

## 1. Use the right config file and environment

- Credentials go in **`backend-dotnet/appsettings.Development.json`** (not `appsettings.json`).
- The backend must run in **Development** so it loads that file. When in doubt, set:
  ```bash
  export ASPNETCORE_ENVIRONMENT=Development
  ```
  before starting the backend (or use `dotnet run` from the project folder, which uses `launchSettings.json` and sets Development).

---

## 2. Restart the .NET backend

- Stop the running backend (Ctrl+C in the terminal where it’s running).
- From the repo root:
  ```bash
  cd backend-dotnet
  dotnet run
  ```
- Confirm in the console that it logs the **new** account ID (e.g. `TSTDRV231585`), not 589861.

---

## 3. Start a new Cloudflare tunnel

- Free `cloudflared` tunnel URLs change every time you start the tunnel and expire when you close it.
- In a **separate** terminal:
  ```bash
  cloudflared tunnel --url http://localhost:5002
  ```
- Copy the **https://xxxxx.trycloudflare.com** URL from the output.

---

## 4. Point the Cloudflare Worker at your tunnel

- Open **`CLOUDFLARE-WORKER-CODE.js`** in this repo.
- Set **`TUNNEL_URL`** to the new tunnel URL from step 3 (replace `https://buildings-escape-lan-singing.trycloudflare.com` or whatever is there).
- In Cloudflare: **Workers & Pages → your worker (e.g. netsuite-proxy) → Edit code → paste the updated code → Save and Deploy.**

---

## 5. Refresh the add-in

- Close the add-in task pane and reopen it (or close and reopen the workbook).
- The add-in calls the Worker → Worker forwards to your tunnel → your backend. The "Connected to …" text comes from your backend’s `/health` response.
- You should see **"Connected (TSTDRV231585)"** (or your new account). Formulas like `=XAVI.NAME(C7)` should then work.

---

## Quick check

- In a browser, open:  
  `https://netsuite-proxy.chris-corcoran.workers.dev/health`  
- You should see JSON with `"account": "TSTDRV231585"`. If you still see `589861`, the Worker is still talking to a backend that has the old config (wrong tunnel or backend not restarted / not using Development).
