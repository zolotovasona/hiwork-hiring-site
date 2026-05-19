const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Resend } = require('resend'); // ✅ Resend SDK
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// ✅ Инициализация Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// ✅ Универсальная функция отправки писем
async function sendEmail(to, subject, html) {
  try {
    const { data, error } = await resend.emails.send({
      from: 'HIWork HR <onboarding@resend.dev>', // Бесплатный тестовый отправитель Resend
      to: to,
      subject: subject,
      html: html
    });

    if (error) {
      console.log('❌ Ошибка Resend:', error);
      return false;
    }
    console.log('✅ Письмо отправлено через Resend:', data.id);
    return true;
  } catch (err) {
    console.error('❌ Критическая ошибка отправки:', err);
    return false;
  }
}

// База данных SQLite
const db = new sqlite3.Database('./hiring.db');

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

  // Демо-треки
  const tracks = ['Java Developer', 'DevOps Engineer', 'Frontend Developer', 'Data Analyst', 'QA Engineer', 'System Architect'];
  tracks.forEach(track => {
    db.run(`INSERT OR IGNORE INTO career_tracks (name) VALUES (?)`, [track]);
  });

  console.log('✅ База данных инициализирована');
});

// 📥 API: Получить все заявки
app.get('/api/applications', (req, res) => {
  console.log('📥 Запрос на получение заявок');
  db.all('SELECT * FROM applications ORDER BY created_at DESC', [], (err, rows) => {
    if (err) {
      console.error('❌ Database error:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log(`✅ Отправлено ${rows.length} заявок`);
    res.json({ applications: rows });
  });
});

// 📈 API: Получить карьерные треки
app.get('/api/tracks', (req, res) => {
  db.all('SELECT name FROM career_tracks', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ tracks: rows.map(r => r.name) });
  });
});

// 📝 API: Подать заявку
app.post('/api/apply', (req, res) => {
  const { full_name, email, career_track, department, experience } = req.body;
  console.log(`📝 Новая заявка: ${full_name} - ${career_track}`);

  if (!full_name || !email || !career_track || !department || !experience) {
    console.log('❌ Не все поля заполнены');
    return res.status(400).json({ error: 'Все поля обязательны' });
  }

  const stmt = db.prepare(`INSERT INTO applications (full_name, email, career_track, department, experience) VALUES (?, ?, ?, ?, ?)`);
  stmt.run(full_name, email, career_track, department, experience, function(err) {
    if (err) {
      console.error('❌ Ошибка сохранения:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log(`✅ Заявка сохранена (ID: ${this.lastID})`);
    res.json({ success: true, message: 'Заявка успешно отправлена!', id: this.lastID });
  });
  stmt.finalize();
});

// 📅 API: Пригласить на собеседование
app.post('/api/interview/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`📅 Приглашение на собеседование: ID ${id}`);

  db.get('SELECT * FROM applications WHERE id = ?', [id], async (err, row) => {
    if (err || !row) {
      console.log('❌ Заявка не найдена');
      return res.status(404).json({ error: 'Заявка не найдена' });
    }

    db.run('UPDATE applications SET status = ? WHERE id = ?', ['interviewing', id], async (dbErr) => {
      if (dbErr) {
        console.error('❌ Ошибка обновления статуса:', dbErr);
        return res.status(500).json({ error: dbErr.message });
      }

      console.log(`📧 Отправляю приглашение на: ${row.email}`);
      const emailSent = await sendEmail(row.email, 'Приглашение на собеседование - HIWorkForHR', `
        <h2>Здравствуйте, ${row.full_name}!</h2>
        <p>Мы рассмотрели вашу заявку на позицию <strong>${row.career_track}</strong> и приглашаем вас на собеседование.</p>
        <p>Свяжемся с вами в ближайшее время для согласования времени.</p>
        <br><p>С уважением,<br>Команда HIWorkForHR</p>
      `);

      console.log(emailSent ? '✅ Статус обновлён и письмо отправлено' : '⚠️ Статус обновлён, но письмо не отправлено');
      res.json({ success: true, message: 'Статус обновлён: собеседование', emailSent });
    });
  });
});

// 🎉 API: Принять на работу + QR код
app.post('/api/hire/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`🎉 Принятие на работу: ID ${id}`);

  db.get('SELECT * FROM applications WHERE id = ?', [id], async (err, row) => {
    if (err || !row) {
      console.log('❌ Заявка не найдена');
      return res.status(404).json({ error: 'Заявка не найдена' });
    }

    const qrData = `HIWORK_HIRE_${id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    QRCode.toDataURL(qrData, async (qrErr, qrCodeUrl) => {
      if (qrErr) {
        console.error('❌ Ошибка генерации QR:', qrErr);
        return res.status(500).json({ error: 'Ошибка генерации QR' });
      }

      db.run('UPDATE applications SET status = ?, qr_code = ? WHERE id = ?', ['hired', qrData, id], async (dbErr) => {
        if (dbErr) {
          console.error('❌ Ошибка обновления статуса:', dbErr);
          return res.status(500).json({ error: dbErr.message });
        }

        console.log(`📧 Отправляю QR-код на: ${row.email}`);
        const emailSent = await sendEmail(row.email, 'Поздравляем! Вы приняты на работу - HIWorkForHR', `
          <h2>Здравствуйте, ${row.full_name}!</h2>
          <p>Поздравляем! Вы приняты на работу на позицию <strong>${row.career_track}</strong>.</p>
          <p>Ваш персональный QR-код для регистрации:</p>
          <img src="${qrCodeUrl}" alt="QR Code" style="width: 200px; height: 200px; border: 2px solid #7B8CFF; border-radius: 8px;" />
          <p><em>Этот QR-код одноразовый и действителен только для первой регистрации.</em></p>
          <br><p>С уважением,<br>Команда HIWorkForHR</p>
        `);

        console.log(emailSent ? '✅ Сотрудник принят, QR отправлен' : '⚠️ Сотрудник принят, но QR не отправлен');
        res.json({ success: true, message: 'Сотрудник принят', emailSent, qrCode: qrCodeUrl });
      });
    });
  });
});

// ➕ API: Добавить карьерный трек
app.post('/api/tracks', (req, res) => {
  const { name } = req.body;
  db.run('INSERT OR IGNORE INTO career_tracks (name) VALUES (?)', [name], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    console.log(`✅ Трек добавлен: ${name}`);
    res.json({ success: true, message: 'Трек добавлен' });
  });
});

// 🧪 API: Тест отправки email
app.get('/api/test-email', async (req, res) => {
  const testEmail = req.query.to || 'test@example.com';
  console.log(`🧪 Тест отправки на: ${testEmail}`);

  const success = await sendEmail(testEmail, '🧪 Тест: отправка работает!', `
    <h2>Привет!</h2>
    <p>Если ты видишь это письмо — Resend работает! ✅</p>
    <p><strong>Кому:</strong> ${testEmail}</p>
    <hr><small>HIWorkForHR • ${new Date().toLocaleString('ru-RU')}</small>
  `);

  res.json(success 
    ? { success: true, message: 'Письмо отправлено!', to: testEmail }
    : { success: false, error: 'Не удалось отправить. Проверь RESEND_API_KEY и логи.' }
  );
});

// 🏠 Главная страница
app.get('/', (req, res) => {
  res.send(`
    <h1>✅ HIWorkForHR API is running!</h1>
    <p>Сервер работает корректно.</p>
    <ul>
      <li><a href="/api/applications">📋 Заявки</a></li>
      <li><a href="/api/tracks">📈 Карьерные треки</a></li>
      <li><a href="/api/test-email">🧪 Тест email</a></li>
    </ul>
  `);
});

// 🩺 Проверка работоспособности
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    email_configured: !!process.env.RESEND_API_KEY
  });
});

// 🚀 Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 ============================================');
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🚀 URL: https://hiwork-hiring-site.onrender.com`);
  console.log(`🚀 API: https://hiwork-hiring-site.onrender.com/api/applications`);
  console.log('🚀 ============================================');
  console.log('📧 Email сервис: Resend');
  console.log('🔑 API Key configured:', process.env.RESEND_API_KEY ? '✅' : '❌');
  console.log('🔍 Для теста: /api/test-email?to=ваша-почта@mail.ru');
  console.log('🚀 ============================================');
});

process.on('unhandledRejection', (error) => console.error('❌ Unhandled promise rejection:', error));
process.on('uncaughtException', (error) => console.error('❌ Uncaught exception:', error));
