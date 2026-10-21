# ExamSync MongoDB setup

The API uses MongoDB for persistent app data. It connects to `mongodb://127.0.0.1:27017` by default and stores the application state in database `examsync`, collection `app_state`.

## Local MongoDB

1. Install and start MongoDB Community Server on this computer.
2. Copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`).
3. Start ExamSync with `npm run start` or run `npm run server` and `npm run dev` in separate terminals.
4. Check `http://localhost:4000/api/health`; it should show `"storage":"MongoDB"`.

## MongoDB Atlas

1. Create a MongoDB Atlas database and a database user.
2. Copy `.env.example` to `.env` and set `MONGODB_URI` to the Atlas connection string. Replace its username, password and database placeholder. Add your current IP address to the Atlas network access allowlist.
3. Set `MONGODB_DB=examsync`, then run the commands above.

On the first start, ExamSync imports `server/data/examsync.json` into MongoDB if the Mongo collection is empty. The JSON file is retained as a backup. Later starts read the MongoDB copy. MongoDB must be running and reachable; the server reports a clear connection error instead of silently switching back to JSON.
