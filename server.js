const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// База данных SQLite
const db = new sqlite3.Database('./hiring.db');

// Создание таблиц
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    career_track TEXT NOT NULL,
    department TEXT NOT NULL,
    experience TEXT NOT NULL,
    status TEXT DEFAULT 'new',
    qr_code TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS career_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  )`);

  // Добавляем демо-треки (если пусто)
  const tracks = ['Java Developer', 'DevOps Engineer', 'Frontend Developer', 'Data Analyst', 'QA Engineer', 'System Architect'];
  tracks.forEach(track => {
    db.run(`INSERT OR IGNORE INTO career_tracks (name) VALUES (?)`, [track]);
  });
});

// Email конфигурация
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// API: Получить все карьерные треки
app.get('/api/tracks', (req, res) => {
  db.all('SELECT name FROM career_tracks', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ tracks: rows.map(r => r.name) });
  });
});

// API: Подать заявку
app.post('/api/apply', async (req, res) => {
  const { full_name, email, career_track, department, experience } = req.body;
  
  if (!full_name || !email || !career_track || !department || !experience) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }

  const stmt = db.prepare(`INSERT INTO applications (full_name, email, career_track, department, experience) VALUES (?, ?, ?, ?, ?)`);
  stmt.run(full_name, email, career_track, department, experience, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    
    // Отправка уведомления в приложение (через webhook или файл)
    console.log(`Новая заявка: ${full_name} - ${career_track}`);
    
    res.json({ success: true, message: 'Заявка успешно отправлена!' });
  });
  stmt.finalize();
});

// API: Получить все заявки (для приложения)
app.get('/api/applications', (req, res) => {
  db.all('SELECT * FROM applications ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ applications: rows });
  });
});

// API: Пригласить на собеседование
app.post('/api/interview/:id', (req, res) => {
  const { id } = req.params;
  
  db.get('SELECT * FROM applications WHERE id = ?', [id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Заявка не найдена' });

    db.run('UPDATE applications SET status = ? WHERE id = ?', ['interviewing', id], (err) => {
      if (err) return res.status(500).json({ error: err.message });

      // Отправка email
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: row.email,
        subject: 'Приглашение на собеседование - HIWorkForHR',
        html: `
          <h2>Здравствуйте, ${row.full_name}!</h2>
          <p>Мы рассмотрели вашу заявку на позицию <strong>${row.career_track}</strong> и приглашаем вас на собеседование.</p>
          <p>Свяжемся с вами в ближайшее время для согласования времени.</p>
          <br>
          <p>С уважением,<br>Команда HIWorkForHR</p>
        `
      };

      transporter.sendMail(mailOptions, (error) => {
        if (error) console.log('Email error:', error);
      });

      res.json({ success: true, message: 'Статус обновлён: собеседование' });
    });
  });
});

// API: Принять на работу + QR код
app.post('/api/hire/:id', async (req, res) => {
  const { id } = req.params;
  
  db.get('SELECT * FROM applications WHERE id = ?', [id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Заявка не найдена' });

    // Генерация одноразового QR кода
    const qrData = `HIWORK_HIRE_${id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    QRCode.toDataURL(qrData, async (err, qrCodeUrl) => {
      if (err) return res.status(500).json({ error: 'Ошибка генерации QR' });

      db.run('UPDATE applications SET status = ?, qr_code = ? WHERE id = ?', ['hired', qrData, id], async (err) => {
        if (err) return res.status(500).json({ error: err.message });

        // Отправка email с QR кодом
        const mailOptions = {
          from: process.env.EMAIL_USER,
          to: row.email,
          subject: 'Поздравляем! Вы приняты на работу - HIWorkForHR',
          html: `
            <h2>Здравствуйте, ${row.full_name}!</h2>
            <p>Поздравляем! Вы приняты на работу на позицию <strong>${row.career_track}</strong>.</p>
            <p>Ваш персональный QR-код для регистрации:</p>
            <img src="${qrCodeUrl}" alt="QR Code" style="width: 200px; height: 200px;" />
            <p><em>Этот QR-код одноразовый и действителен только для первой регистрации.</em></p>
            <br>
            <p>С уважением,<br>Команда HIWorkForHR</p>
          `
        };

        try {
          await transporter.sendMail(mailOptions);
          res.json({ success: true, message: 'Сотрудник принят, QR отправлен', qrCode: qrCodeUrl });
        } catch (error) {
          res.json({ success: true, message: 'Сотрудник принят, но email не отправлен', qrCode: qrCodeUrl });
        }
      });
    });
  });
});

// API: Добавить карьерный трек (синхронизация с приложением)
app.post('/api/tracks', (req, res) => {
  const { name } = req.body;
  db.run('INSERT OR IGNORE INTO career_tracks (name) VALUES (?)', [name], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Трек добавлен' });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});