# MITR Web Simulator (Vercel)

Deploy this folder as a static site on Vercel.

## Vercel setup

1. Import repo: `https://github.com/joshaeeee/MITR`.
2. Set **Root Directory** to: `mitr-backend/tools/web-sim`.
3. Framework preset: `Other`.
4. Build command: leave empty.
5. Output directory: leave empty.
6. Deploy.

## API host configuration

The simulator reads API host in this order:

1. URL query param `?apiHost=...` (or `?host=...`)
2. `localStorage` key `mitr_websim_host`
3. Default: `http://127.0.0.1:8080`

Examples:

- `https://your-sim.vercel.app/?apiHost=https://api.yourdomain.com`
- `https://your-sim.vercel.app/?host=https://api.yourdomain.com`

Important: if simulator is served on HTTPS (Vercel), backend should also be HTTPS. Browsers block mixed-content requests from HTTPS -> HTTP.

## Runtime context debugging

The simulator shows the latest `runtime_context` packet sent by the Pipecat gateway.
Enable gateway context injection locally with:

```sh
MITR_GATEWAY_INJECT_BOOT_CONTEXT=true
```

When enabled, the gateway injects a compact context packet on WebSocket connect
and again after wake phrase detection. The packet is displayed in the simulator
without being read aloud by the agent.
