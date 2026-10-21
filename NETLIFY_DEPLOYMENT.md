# Deploying ExamSync with Netlify

Netlify hosts the built React/Vite frontend. The Node.js API must run on a separate Node-capable host connected to MongoDB Atlas; Netlify's static hosting does not run `server/index.js` as a long-running API server.

## Backend host settings

Use the repository as a Node web service with:

- Build command: `npm install`
- Start command: `npm run server`
- Environment variables:
  - `MONGODB_URI`: MongoDB Atlas connection string
  - `MONGODB_DB`: `examsync`
  - `FRONTEND_ORIGIN`: the exact Netlify site origin, e.g. `https://your-site.netlify.app` (no path or trailing slash)

The API listens on the host-provided `PORT`. After deployment, open `https://YOUR-API-HOST/api/health`; it must return JSON with `"storage":"MongoDB"` before connecting the frontend.

## Netlify settings

In the Netlify site's environment variables, set:

- `VITE_API_URL`: the backend origin, e.g. `https://your-api-host.example.com` (no `/api` suffix)

Trigger a new Netlify deploy after changing this value. Then open the site and sign in again. Requests such as `/api/auth/login` will be sent to `VITE_API_URL` instead of the Netlify static host.

If the backend health URL works but the browser reports a CORS error, set `FRONTEND_ORIGIN` on the backend to the exact URL shown in the browser address bar and redeploy/restart the backend.
