import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';

dotenv.config();

// __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Allow your frontend origin (set this in Render > Environment)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: '20mb' }));

// Optional: save a copy of submissions on disk
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'submissions');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Health route (Render checks this)
app.get('/', (req, res) => res.send('OSD backend is up'));

// ---- PDF helper ----
function buildPdfBuffer(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('OSD – Driver Sign-Off', { underline: true });
    doc.moveDown();

    const rows = [
      ['Date/Time', data.timestamp],
      ['Location', data.location],
      ['Load ID / BOL #', data.loadId],
      ['PO Number', data.poNumber],
      ['Trailer #', data.trailerNumber],
      ['Stop #', data.stopNumber],
      ['Driver Name', data.driverName],
