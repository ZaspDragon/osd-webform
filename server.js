import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import nodemailer from 'nodemailer'
import PDFDocument from 'pdfkit'
import { v4 as uuidv4 } from 'uuid'
import { fileURLToPath } from 'url'

dotenv.config()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: '20mb' }))

const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'submissions')
fs.mkdirSync(OUT_DIR, { recursive: true })

app.get('/', (req, res) => res.send('OSD server running'))

app.listen(8080, () => console.log('Server running on port 8080'))
