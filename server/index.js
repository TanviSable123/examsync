import 'dotenv/config';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MongoClient } from 'mongodb';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const dbFile = path.join(dataDir, 'examsync.json');
const port = Number(process.env.API_PORT || process.env.PORT || 4000);
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const mongoDbName = process.env.MONGODB_DB || 'examsync';
const sessions = new Map();

function examStart(student) {
  if (!student.date) return null;
  const date = new Date(student.date);
  if (Number.isNaN(date.getTime())) return null;
  const time = String(student.time || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (time) { let hour = Number(time[1]); const meridiem=time[3]?.toUpperCase(); if (meridiem==='PM' && hour<12) hour+=12; if (meridiem==='AM' && hour===12) hour=0; date.setHours(hour, Number(time[2]), 0, 0); }
  return date;
}
function rosterFor(session) {
  return db.roster.filter(student => {
    if (session.role === 'student') return student.id.toLowerCase() === String(session.roll || '').toLowerCase();
    if (session.role === 'teacher') return String(student.teacher||'').toLowerCase() === String(session.name||'').toLowerCase();
    return true;
  }).map(student => {
    const start = examStart(student); const now = Date.now();
    const visible = !start || now >= start.getTime() - (session.role === 'student' ? 3 : 24) * 60 * 60 * 1000;
    if (visible) return student;
    const { room, seat, ...safe } = student;
    return { ...safe, room:'Available closer to the exam', seat:'—' };
  });
}

const initialPlans = [
  { ref: 'EX-104', exam: 'Applied Computing', date: '21 Oct · 10:00 AM', arrangement: '30-minute extra time', room: 'B-204', seat: 'B12', end: '12:30 PM', status: 'Needs attention', timing: false, briefing: false, roomOk: true, equipment: true, owner: 'Exam Coordinator' },
  { ref: 'EX-105', exam: 'Information Systems', date: '22 Oct · 1:00 PM', arrangement: 'Quiet-room arrangement', room: 'Not assigned', seat: '—', end: '3:00 PM', status: 'Needs attention', timing: true, briefing: true, roomOk: false, equipment: true, owner: 'Accommodation Coordinator' },
  { ref: 'EX-106', exam: 'Database Systems', date: '23 Oct · 9:30 AM', arrangement: 'Approved assistive device', room: 'A-103', seat: 'A08', end: '11:30 AM', status: 'Needs attention', timing: true, briefing: false, roomOk: true, equipment: false, owner: 'Invigilator' },
  { ref: 'EX-107', exam: 'Network Fundamentals', date: '24 Oct · 11:00 AM', arrangement: 'Accessible seating', room: 'C-101', seat: 'C04', end: '1:00 PM', status: 'Ready', timing: true, briefing: true, roomOk: true, equipment: true, owner: 'Exam Coordinator' }
];

await mkdir(dataDir, { recursive: true });
await mkdir(uploadsDir, { recursive: true });
const mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS:8000 });
try {
  await mongoClient.connect();
} catch (error) {
  console.error('Could not connect to MongoDB. Start MongoDB locally or check the MONGODB_URI in your .env file.');
  throw error;
}
const stateCollection = mongoClient.db(mongoDbName).collection('app_state');
let db;
const savedState = await stateCollection.findOne({ _id:'main' });
if (savedState?.state) {
  db = savedState.state;
} else {
  try {
    db = JSON.parse(await readFile(dbFile, 'utf8'));
    console.log('Migrating existing ExamSync JSON data into MongoDB…');
  } catch {
    db = { plans:structuredClone(initialPlans), issues:[], roster:[
      { id:'STU-204', name:'Aanya Sharma', exam:'Applied Computing', date:'2026-10-21', room:'B-204', seat:'B12', time:'10:00 AM', teacher:'Dr. Meera Rao', code:'', approved:false },
      { id:'STU-205', name:'Kabir Patel', exam:'Applied Computing', date:'2026-10-21', room:'B-204', seat:'B13', time:'10:00 AM', teacher:'Dr. Meera Rao', code:'', approved:false },
      { id:'STU-206', name:'Ira Nair', exam:'Information Systems', date:'2026-10-21', room:'A-103', seat:'A08', time:'1:00 PM', teacher:'Prof. Dev Shah', code:'', approved:false }
    ], rooms:[{ room:'B-204', seats:['B12','B13','B14','B15','B16'], teacher:'Dr. Meera Rao' },{ room:'A-103', seats:['A08','A09','A10','A11'], teacher:'Prof. Dev Shah' }], teachers:[{id:'FAC-01',name:'Dr. Meera Rao',room:'B-204',exam:'Applied Computing'},{id:'FAC-02',name:'Prof. Dev Shah',room:'A-103',exam:'Information Systems'}], accommodationRequests:[], allocationCount:0, faceTemplates:{} };
  }
  if (!Array.isArray(db.plans) || !Array.isArray(db.issues)) throw new Error('Invalid ExamSync application state.');
  db.roster ||= [];
  db.rooms ||= [];
  db.roster = db.roster.map(student => ({ ...student, date:student.date || '2026-10-21' }));
  db.accommodationRequests ||= [];
  db.teachers ||= [];
  db.allocationCount ||= 0;
  db.faceTemplates ||= {};
  await persist();
}

async function persist() {
  await stateCollection.replaceOne({ _id:'main' }, { _id:'main', state:db, updatedAt:new Date() }, { upsert:true });
}
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (raw.length > 20_000_000) throw Object.assign(new Error('Request body is too large (20 MB maximum).'), { status: 413 });
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}

function getSession(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return token ? sessions.get(token) : null;
}

function requireRole(session, allowed) {
  if (!session) throw Object.assign(new Error('Sign in to continue.'), { status: 401 });
  if (allowed && !allowed.includes(session.role)) throw Object.assign(new Error('Your role cannot perform this action.'), { status: 403 });
}

export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(value=>value.trim()).filter(Boolean);
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (req.method === 'OPTIONS') {
    if (origin && !allowedOrigins.includes(origin)) return send(res, 403, { error:'This website is not allowed to call the ExamSync API.' });
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method || 'GET';
  const session = getSession(req);
  try {
    if (method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, name: 'ExamSync API', version: 3, workbookImport: true, storage: 'MongoDB', database: mongoDbName, collection: 'app_state' });

    if (method === 'GET' && url.pathname === '/api/workflow') {
      requireRole(session);
      return send(res, 200, { roster: rosterFor(session), rooms: session.role==='exam'?db.rooms:[], teachers:session.role==='exam'?db.teachers:[], requests: session.role==='exam'?db.accommodationRequests:db.accommodationRequests.filter(item => item.roll === session.roll), allocationCount: db.allocationCount, faceEnrolled:session.role==='teacher'?Boolean(db.faceTemplates?.[session.name.toLowerCase()]):false });
    }

    if (method === 'POST' && url.pathname === '/api/teacher/face/enroll') {
      requireRole(session, ['teacher']);
      const body = await readBody(req);
      const descriptor = body.descriptor;
      if (body.consent !== true) return send(res, 400, { error:'Consent is required before storing a face template.' });
      if (!Array.isArray(descriptor) || descriptor.length !== 128 || descriptor.some(value => !Number.isFinite(value) || Math.abs(value) > 2)) return send(res, 400, { error:'A valid 128-value face descriptor is required.' });
      db.faceTemplates ||= {};
      db.faceTemplates[session.name.toLowerCase()] = descriptor;
      session.faceVerifiedAt = null;
      session.faceVerifiedDistance = null;
      await persist();
      return send(res, 201, { enrolled:true });
    }

    if (method === 'POST' && url.pathname === '/api/teacher/face/verify') {
      requireRole(session, ['teacher']);
      const body = await readBody(req);
      const descriptor = body.descriptor;
      const reference = db.faceTemplates?.[session.name.toLowerCase()];
      if (!reference) return send(res, 409, { error:'Enroll your face before verifying.' });
      if (!Array.isArray(descriptor) || descriptor.length !== 128 || descriptor.some(value => !Number.isFinite(value) || Math.abs(value) > 2)) return send(res, 400, { error:'A valid 128-value face descriptor is required.' });
      const distance = Math.sqrt(descriptor.reduce((sum, value, index) => sum + (value - reference[index]) ** 2, 0));
      const matched = distance <= 0.5;
      session.faceVerifiedAt = matched ? Date.now() : null;
      session.faceVerifiedDistance = matched ? distance : null;
      return send(res, 200, { matched, distance, threshold:0.5 });
    }

    if (method === 'POST' && url.pathname === '/api/teacher/face/remove') {
      requireRole(session, ['teacher']);
      if (db.faceTemplates) delete db.faceTemplates[session.name.toLowerCase()];
      session.faceVerifiedAt = null;
      session.faceVerifiedDistance = null;
      await persist();
      return send(res, 200, { enrolled:false });
    }

    if (method === 'POST' && url.pathname === '/api/coordinator/import') {
      requireRole(session, ['exam']);
      const body = await readBody(req);
      const files = Array.isArray(body.files) ? body.files : body.fileName && body.data ? [{ kind:'combined', fileName:body.fileName, data:body.data }] : [];
      if (!files.length || files.some(file=>!file.fileName || !file.data)) return send(res, 400, { error: 'Choose the student, teacher, and room/bench .xlsx files.' });
      if (files.length > 1 && ['students','teachers','rooms'].some(kind=>!files.some(file=>file.kind===kind))) return send(res,400,{error:'Select exactly one student file, one teacher file, and one classroom/bench file.'});
      const buffers = files.map(file=>Buffer.from(String(file.data),'base64'));
      if (buffers.some(bytes=>!bytes.length || bytes.length>14_000_000)) return send(res, 413, { error: 'Each workbook must be smaller than 14 MB.' });
      const tempFiles = files.map(()=>path.join(dataDir,`import-${randomUUID()}.xlsx`));
      try {
        for (const [i,file] of files.entries()) await writeFile(tempFiles[i],buffers[i]);
        const parsedFiles = tempFiles.map(tempFile=>spawnSync('python',[path.join(here,'parse_xlsx.py'),tempFile],{encoding:'utf8',timeout:15000,maxBuffer:10_000_000}));
        if (parsedFiles.some(parsed=>parsed.error||parsed.status!==0)) return send(res,422,{error:'Could not read a workbook. Save each file as .xlsx and check its sheet has a header row.'});
        const candidateRows=[],roomRows=[],teacherRows=[];
        parsedFiles.forEach((parsed,i)=>{
          const sheets=JSON.parse(parsed.stdout), entries=Object.entries(sheets), kind=files[i].kind;
          const byName=(pattern)=>entries.find(([name])=>pattern.test(name))?.[1];
          if (kind==='students') candidateRows.push(...(byName(/candidate|student|roster/i)||Object.values(sheets)[0]||[]));
          else if (kind==='rooms') roomRows.push(...(byName(/room|bench|seat|class/i)||Object.values(sheets)[0]||[]));
          else if (kind==='teachers') teacherRows.push(...(byName(/teacher|faculty|invigilator/i)||Object.values(sheets)[0]||[]));
          else { candidateRows.push(...(byName(/candidate|student|roster/i)||[]));roomRows.push(...(byName(/room|bench|seat|class/i)||[]));teacherRows.push(...(byName(/teacher|faculty|invigilator/i)||[])); }
        });
        const candidatesSheet=candidateRows,roomsSheet=roomRows,teachersSheet=teacherRows;
        const norm = value => String(value ?? '').trim();
        const pick = (row, keys) => { const entry = Object.entries(row).find(([key]) => keys.includes(key.toLowerCase().replace(/[^a-z0-9]/g, ''))); return norm(entry?.[1]); };
        const roster = candidatesSheet.map((row, i) => ({
          id: pick(row, ['roll','rollno','rollid','rollnumber','studentid','studentno','studentnumber','studentcode','registrationno','registrationnumber','enrollmentno','enrollmentnumber','admissionnumber','id','candidateid']) || `STU-${300+i}`,
          name: pick(row, ['name','studentname','candidatename']) || `Candidate ${i+1}`,
          exam: pick(row, ['exam','subject','course','paper']) || 'Exam',
          room: pick(row, ['room','roomno','roomnumber']) || 'Unassigned',
          seat: pick(row, ['seat','seatno','bench','benchno']) || 'Unassigned',
          time: pick(row, ['time','starttime','examtime']) || 'TBC',
          date: pick(row, ['date','examdate']) || '',
          teacher: pick(row, ['teacher','teachername','teachernames','faculty','facultyname']) || 'Unassigned',
          code: '', approved: false
        })).filter(row => row.name && row.exam);
        const roomMap = new Map();
        for (const row of roomsSheet) {
          const room = pick(row,['room','roomno','roomnumber','classroom','classroomno','classroomnumber']); if (!room) continue;
          const entry = roomMap.get(room) || { room, seats:[], teacher:pick(row,['teacher','teachername','faculty']), capacity:0 };
          const seat = pick(row,['seat','seatno','bench','benchno']); if (seat) entry.seats.push(seat);
          entry.capacity = Math.max(entry.capacity, Number(pick(row,['capacity','seats','benchcount','numberofbenches','numberofseats','benches'])) || 0);
          roomMap.set(room, entry);
        }
        for (const row of teachersSheet) {
          const room = pick(row,['room','roomno','roomnumber','classroom','classroomno','classroomnumber']);
          const teacher = pick(row,['teacher','teachername','teachernames','faculty','facultyname','name']);
          if (room && teacher && roomMap.has(room)) roomMap.get(room).teacher = teacher;
        }
        const rooms = [...roomMap.values()].map(room => ({ ...room, seats:room.seats.length ? room.seats : Array.from({length:room.capacity},(_,i)=>`${room.room}-${String(i+1).padStart(2,'0')}`) }));
        const teachers=teacherRows.map(row=>({id:pick(row,['teacherid','staffid','facultyid','id']),name:pick(row,['teacher','teachername','teachernames','faculty','facultyname','name']),room:pick(row,['room','roomno','roomnumber','classroom','classroomno','classroomnumber']),exam:pick(row,['exam','subject','course','paper'])})).filter(row=>row.name);
        for (const room of rooms) if (room.teacher==='Unassigned') room.teacher=teachers.find(item=>item.room===room.room)?.name || 'Unassigned';
        for (const student of roster) if (student.teacher === 'Unassigned') student.teacher = rooms.find(room=>room.room===student.room)?.teacher || teachers.find(item=>item.exam.toLowerCase()===student.exam.toLowerCase())?.name || (teachers.length===1?teachers[0].name:'Unassigned');
        if (!roster.length) return send(res, 422, { error: 'No candidate rows found. Include columns for student name and exam.' });
        db.roster = roster; db.rooms = rooms.length ? rooms : db.rooms; db.teachers=teachers.length?teachers:db.teachers; db.allocationCount = 0;
        await persist();
      return send(res, 200, { imported: roster.length, rooms: db.rooms.length, teachers:db.teachers.length, roster: db.roster, rooms: db.rooms, teachersList:db.teachers, requests: db.accommodationRequests, allocationCount: db.allocationCount });
      } finally { const fs=await import('node:fs/promises'); await Promise.all(tempFiles.map(tempFile=>fs.rm(tempFile,{force:true}))); }
    }

    if (method === 'PATCH' && url.pathname === '/api/coordinator/room-teachers') {
      requireRole(session,['exam']);
      const { assignments=[] } = await readBody(req);
      for (const item of assignments) {
        const room=db.rooms.find(entry=>entry.room===item.room);
        if (!room || !db.teachers.some(teacher=>teacher.name===item.teacher)) continue;
        room.teacher=item.teacher;
        db.roster=db.roster.map(student=>student.room===room.room?{...student,teacher:item.teacher}:student);
      }
      await persist(); return send(res,200,{rooms:db.rooms,roster:db.roster});
    }

    if (method === 'PATCH' && url.pathname === '/api/coordinator/exam-rooms') {
      requireRole(session,['exam']);
      const { assignments=[] } = await readBody(req);
      for (const item of assignments) {
        if (!db.rooms.some(room=>room.room===item.room)) continue;
        db.roster=db.roster.map(student=>student.exam===item.exam?{...student,room:item.room}:student);
      }
      await persist(); return send(res,200,{roster:db.roster});
    }

    if (method === 'POST' && url.pathname === '/api/coordinator/allocate') {
      requireRole(session, ['exam']);
      const body = await readBody(req);
      if (db.allocationCount > 0 && body.password !== 'demo2026') return send(res, 403, { error: 'Enter the coordinator password to run the second allocation.' });
      if (db.rooms.length > 1 && db.roster.some(student=>!student.room || student.room==='Unassigned')) return send(res,400,{error:'Assign each exam session to a classroom before allocating seats.'});
      const assigned = new Map();
      const roster = db.roster.map(student => {
        const sessionKey = `${student.exam}|${student.date||student.time||''}`;
        const choices = student.room !== 'Unassigned' ? [...db.rooms].sort((a,b)=>(a.room===student.room?-1:0)-(b.room===student.room?-1:0)) : db.rooms;
        for (const room of choices) {
          const key = `${sessionKey}|${room.room}`;
          const used = assigned.get(key) || new Set();
          const seats = room.seats?.length ? room.seats : [];
          const rotation = db.allocationCount ? 1 : 0;
          const orderedSeats = [...seats.slice(rotation), ...seats.slice(0, rotation)];
          const available = orderedSeats.find(seat => !used.has(seat));
          if (!available) continue;
          used.add(available); assigned.set(key, used);
          return { ...student, room:room.room, seat:available, teacher:student.teacher==='Unassigned' ? room.teacher || 'Unassigned' : student.teacher };
        }
        return { ...student, room:'Unassigned', seat:'No seat available' };
      });
      db.roster = roster; db.allocationCount += 1; await persist();
      return send(res, 200, { roster, allocationCount:db.allocationCount });
    }

    if (method === 'POST' && url.pathname === '/api/accommodation-requests') {
      requireRole(session, ['student']);
      const body = await readBody(req);
      if (!body.fileName || !body.data) return send(res, 400, { error: 'Select a supporting PDF or image.' });
      const extension = path.extname(String(body.fileName)).toLowerCase();
      if (!['.pdf','.png','.jpg','.jpeg','.webp'].includes(extension)) return send(res, 415, { error:'Upload a PDF, PNG, JPG, or WebP file.' });
      const bytes = Buffer.from(String(body.data), 'base64');
      if (!bytes.length || bytes.length > 8_000_000) return send(res, 413, { error:'Supporting file must be smaller than 8 MB.' });
      const storageKey = `${randomUUID()}${extension}`;
      await writeFile(path.join(uploadsDir, storageKey), bytes);
      const request = { id:`REQ-${randomUUID().slice(0,8).toUpperCase()}`, student:session.name, roll:session.roll, fileName:String(body.fileName).slice(0,180), storageKey, status:'Pending review', createdAt:new Date().toISOString(), code:'' };
      db.accommodationRequests.unshift(request); await persist();
      return send(res, 201, { request });
    }

    const documentMatch = url.pathname.match(/^\/api\/accommodation-requests\/([^/]+)\/document$/);
    if (method === 'GET' && documentMatch) {
      requireRole(session, ['student','exam']);
      const request = db.accommodationRequests.find(item => item.id === decodeURIComponent(documentMatch[1]));
      if (!request || (session.role === 'student' && request.roll !== session.roll)) return send(res, 404, { error:'Document not found.' });
      if (!request.storageKey) return send(res, 404, { error:'Document is not available.' });
      const file = await readFile(path.join(uploadsDir, path.basename(request.storageKey)));
      const types = { '.pdf':'application/pdf', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' };
      res.writeHead(200, { 'Content-Type':types[path.extname(request.storageKey)] || 'application/octet-stream', 'Content-Length':file.length, 'Content-Disposition':'inline', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
      return res.end(file);
    }

    const accommodationMatch = url.pathname.match(/^\/api\/accommodation-requests\/([^/]+)\/verify$/);
    if (method === 'POST' && accommodationMatch) {
      requireRole(session, ['exam']);
      const request = db.accommodationRequests.find(item => item.id === decodeURIComponent(accommodationMatch[1]));
      if (!request) return send(res, 404, { error:'Accommodation request not found.' });
      request.status = 'Verified'; request.code = `ES-${request.roll.replace(/[^a-z0-9]/gi,'').toUpperCase()}-${randomUUID().slice(0,6).toUpperCase()}`;
      const student = db.roster.find(item => item.id.toLowerCase() === request.roll.toLowerCase());
      if (student) { student.approved = true; student.code = request.code; }
      await persist(); return send(res, 200, { request, roster:db.roster });
    }

    if (method === 'POST' && url.pathname === '/api/teacher/seat-change') {
      requireRole(session, ['teacher']);
      const body = await readBody(req);
      const studentId = String(body.studentId || '').trim();
      const requestedSeat = String(body.requestedSeat || '').trim().slice(0, 100);
      const reason = String(body.reason || '').trim().slice(0, 1000);
      const faceVerifiedAt = Number(session.faceVerifiedAt || 0);
      if (!studentId || !requestedSeat || !reason) return send(res, 400, { error:'Choose a candidate and requested seat, and explain the reason for the change.' });
      if (!Number.isFinite(session.faceVerifiedDistance) || session.faceVerifiedDistance > 0.5 || !faceVerifiedAt || Date.now() - faceVerifiedAt > 5 * 60 * 1000) return send(res, 403, { error:'Verify your enrolled face again before sending this seat-change request. Verification is valid for five minutes.' });
      const faceMatchDistance = session.faceVerifiedDistance;
      const student = db.roster.find(item => item.id.toLowerCase() === studentId.toLowerCase());
      if (!student) return send(res, 404, { error:'Candidate not found in the imported roster.' });
      if (String(student.teacher || '').toLowerCase() !== String(session.name || '').toLowerCase()) return send(res, 403, { error:'You can request a seat change only for a candidate assigned to you.' });
      if (requestedSeat.toLowerCase() === String(student.seat || '').toLowerCase()) return send(res, 400, { error:'Choose a seat different from the current allocation.' });
      const now = new Date().toISOString();
      const plan = db.plans.find(item => item.exam.toLowerCase() === String(student.exam || '').toLowerCase());
      const issue = {
        id:`ISS-${randomUUID().slice(0,8).toUpperCase()}`,
        title:`Seat change requested · ${student.id}`,
        description:`Candidate: ${student.name} (${student.id})\nCurrent allocation: ${student.room || 'Unassigned'} · ${student.seat || 'Unassigned'}\nRequested allocation: ${requestedSeat}\nTeacher reason: ${reason}\nFace check: local face descriptor matched at distance ${faceMatchDistance.toFixed(3)}. No camera image or face descriptor was sent to the server. Coordinator review is required before any allocation changes.`,
        category:'Seat arrangement change', ref:plan?.ref || 'ROSTER', exam:student.exam,
        createdBy:session.name, createdAt:now, status:'exam_review',
        history:[{label:'Face match passed; seat change sent to Exam Coordinator',role:session.name,at:now}]
      };
      db.issues.unshift(issue);
      session.faceVerifiedAt = null;
      session.faceVerifiedDistance = null;
      await persist();
      return send(res,201,{issue});
    }

    if (method === 'POST' && url.pathname === '/api/teacher/verify-code') {
      requireRole(session, ['teacher']);
      const { code } = await readBody(req);
      const student = db.roster.find(item => item.code && item.code.toLowerCase() === String(code || '').trim().toLowerCase());
      return student ? send(res, 200, { valid:true, student:{ name:student.name, exam:student.exam, approved:student.approved } }) : send(res, 404, { valid:false, error:'Code not found in the authorized exam register.' });
    }

    if (method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readBody(req);
      const roles = ['student', 'teacher', 'accommodation', 'exam', 'invigilator', 'admin'];
      if (!roles.includes(body.role)) return send(res, 400, { error: 'Choose a valid workspace role.' });
      let user;
      if (body.role === 'student') {
        if (!String(body.name || '').trim() || !String(body.roll || '').trim()) return send(res, 400, { error: 'Enter your name and roll number.' });
        const roll=String(body.roll).trim().slice(0,40);
        const candidate=db.roster.find(item=>item.id.toLowerCase()===roll.toLowerCase());
        if (!candidate) return send(res,404,{error:'Student ID not found. Ask the Exam Coordinator to import your roster first.'});
        user = { name: candidate.name, roll, role: body.role };
      } else {
        if (String(body.password || '').trim() !== 'demo2026') return send(res, 401, { error: 'Incorrect demo password. For this demo, enter demo2026.' });
        const labels = { teacher: 'Dr. Meera Rao', accommodation: 'Accommodation Coordinator', exam: 'Exam Coordinator', invigilator: 'Invigilator', admin: 'Administrator' };
        const name=body.role==='teacher'?String(body.name||'').trim():labels[body.role]||'Demo user';
        if (body.role==='teacher' && !name) return send(res,400,{error:'Enter your teacher name as it appears in the teacher workbook.'});
        if (body.role==='teacher' && db.teachers.length && !db.teachers.some(teacher=>teacher.name.toLowerCase()===name.toLowerCase())) return send(res,404,{error:'Teacher name not found in the imported teacher list. Check spelling with the Exam Coordinator.'});
        user = { name, role: body.role };
      }
      const token = randomUUID();
      sessions.set(token, user);
      return send(res, 200, { token, user, plans: db.plans, issues: db.issues });
    }

    if (method === 'GET' && url.pathname === '/api/auth/me') {
      requireRole(session);
      return send(res, 200, { user: session, plans: db.plans, issues: db.issues });
    }
    if (method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (token) sessions.delete(token);
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && url.pathname === '/api/plans') {
      requireRole(session);
      return send(res, 200, { plans: db.plans });
    }
    const planMatch = url.pathname.match(/^\/api\/plans\/([^/]+)$/);
    if (method === 'PATCH' && planMatch) {
      requireRole(session);
      const ref = decodeURIComponent(planMatch[1]);
      const plan = db.plans.find(item => item.ref === ref);
      if (!plan) return send(res, 404, { error: 'Exam plan not found.' });
      const body = await readBody(req);
      const allowedFields = ['timing', 'briefing', 'roomOk', 'equipment', 'room', 'seat', 'end', 'status', 'owner'];
      const keys = Object.keys(body);
      if (!keys.length || keys.some(key => !allowedFields.includes(key))) return send(res, 400, { error: 'Unsupported plan update.' });
      if (session.role === 'teacher' && keys.some(key => key !== 'briefing')) return send(res, 403, { error: 'Teachers can update briefing acknowledgements only.' });
      if (session.role === 'invigilator' && keys.some(key => !['briefing', 'equipment'].includes(key))) return send(res, 403, { error: 'Invigilators can update briefing and equipment checks only.' });
      Object.assign(plan, body);
      await persist();
      return send(res, 200, { plan });
    }

    if (method === 'GET' && url.pathname === '/api/issues') {
      requireRole(session);
      return send(res, 200, { issues: db.issues });
    }
    if (method === 'POST' && url.pathname === '/api/issues') {
      requireRole(session, ['teacher']);
      const body = await readBody(req);
      const plan = db.plans.find(item => item.ref === body.ref);
      const title = String(body.title || '').trim();
      const description = String(body.description || '').trim();
      const category = String(body.category || '').trim();
      if (!plan || !title || !description || !category) return send(res, 400, { error: 'Exam, issue type, title and details are required.' });
      const now = new Date().toISOString();
      const issue = {
        id: `ISS-${randomUUID().slice(0, 8).toUpperCase()}`,
        title: title.slice(0, 90), description: description.slice(0, 2000), category: category.slice(0, 60),
        ref: plan.ref, exam: plan.exam, createdBy: session.name, createdAt: now, status: 'exam_review',
        history: [{ label: 'Reported by teacher', role: session.name, at: now }]
      };
      db.issues.unshift(issue);
      await persist();
      return send(res, 201, { issue, issues: db.issues });
    }
    const issueMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (method === 'PATCH' && issueMatch) {
      const id = decodeURIComponent(issueMatch[1]);
      const issue = db.issues.find(item => item.id === id);
      if (!issue) return send(res, 404, { error: 'Issue not found.' });
      const body = await readBody(req);
      const now = new Date().toISOString();
      if (session?.role === 'exam' && issue.status === 'exam_review' && body.status === 'accommodation_review') {
        issue.status = 'accommodation_review';
        issue.history.push({ label: 'Reviewed and forwarded', role: session.name, at: now });
      } else if (session?.role === 'accommodation' && issue.status === 'accommodation_review' && body.status === 'resolved') {
        issue.status = 'resolved';
        issue.history.push({ label: 'Marked resolved', role: session.name, at: now });
      } else {
        requireRole(session);
        return send(res, 403, { error: 'This issue is not assigned to your role or the requested transition is invalid.' });
      }
      await persist();
      return send(res, 200, { issue, issues: db.issues });
    }

    if (method === 'POST' && url.pathname === '/api/demo/reset') {
      requireRole(session, ['admin']);
      db = { plans: structuredClone(initialPlans), issues: [] };
      db.roster = [
        { id:'STU-204', name:'Aanya Sharma', exam:'Applied Computing', date:'2026-10-21', room:'B-204', seat:'B12', time:'10:00 AM', teacher:'Dr. Meera Rao', code:'', approved:false },
        { id:'STU-205', name:'Kabir Patel', exam:'Applied Computing', date:'2026-10-21', room:'B-204', seat:'B13', time:'10:00 AM', teacher:'Dr. Meera Rao', code:'', approved:false },
        { id:'STU-206', name:'Ira Nair', exam:'Information Systems', date:'2026-10-21', room:'A-103', seat:'A08', time:'1:00 PM', teacher:'Prof. Dev Shah', code:'', approved:false }
      ];
      db.rooms = [{ room:'B-204', seats:['B12','B13','B14','B15','B16'], teacher:'Dr. Meera Rao' }, { room:'A-103', seats:['A08','A09','A10','A11'], teacher:'Prof. Dev Shah' }];
      db.accommodationRequests = []; db.allocationCount = 0;
      await persist();
      return send(res, 200, { plans: db.plans, issues: db.issues });
    }
    if (method === 'POST' && url.pathname === '/api/demo/scenario/reset') {
      requireRole(session, ['exam', 'accommodation', 'invigilator', 'admin']);
      db.plans = structuredClone(initialPlans);
      await persist();
      return send(res, 200, { plans: db.plans });
    }

    return send(res, 404, { error: 'API route not found.' });
  } catch (error) {
    return send(res, error.status || 500, { error: error.status ? error.message : 'The API could not complete this request.' });
  }
});

if (process.env.EXAMSYNC_NO_LISTEN !== '1') server.listen(port, '0.0.0.0', () => {
  console.log(`ExamSync API listening at http://localhost:${port}`);
  console.log(`MongoDB persistence: ${mongoDbName}.app_state`);
});
