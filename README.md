# ExamSync UI Redesign

A responsive React/Vite application with a Node API, role-based exam coordination workflows, persistent local demo records, and Excel workbook import.

## Run the app and backend locally
1. Install Node.js and Python 3.10+ (the Python standard library parses `.xlsx` files). Run `npm install` once.
2. Open PowerShell in the folder containing `package.json` and run:
   ```powershell
   npm start
   ```
3. Open the website URL printed by the command. The same command starts a matching API on an automatically selected free port, avoiding stale processes on ports 4000/5173.
4. Keep that PowerShell window open. Press Ctrl+C once to stop both services.

## Demo login
- Sign in as Exam Coordinator with password: `demo2026`.
- To sign in as a Teacher, enter the exact teacher name from the uploaded teacher workbook and password `demo2026`.
- Students sign in using their name and student ID from the uploaded roster.
- From the Exam Coordinator workspace, select all three files in `sample/`: `ExamSync_Students_30.xlsx`, `ExamSync_Teachers.xlsx`, and `ExamSync_Classrooms_Benches.xlsx`.
- Assign teachers to rooms, then allocate seats. The first allocation runs without another password; a second run asks for `demo2026`.
- The first allocation runs without another password; a second run asks for `demo2026`.
- Roster, room, accommodation request, barcode-code and allocation-attempt records are stored in `server/data/examsync.json` and persist when the backend restarts. Uploaded demo documents are stored in `server/data/uploads/` and can be opened by the student or Exam Coordinator.
- Student seat details are hidden until three hours before exam time; teachers see room details one day before.
- The server source is `server/index.js`; the API helper used by the React app is `src/api.js`.

## Important
This is a local prototype backend. Demo users and passwords are hard-coded, sessions are held in memory, and the JSON file and uploaded demo files are not encrypted or designed for concurrent production traffic. Use fictional data only. Supabase credentials are not configured. The face-check screen is a placeholder and does not perform biometric recognition; the gate code is rendered as a Code 39 barcode and can also be entered manually. Production needs Supabase configuration with private storage and access policies, secure authentication, and an enrolled face model.
