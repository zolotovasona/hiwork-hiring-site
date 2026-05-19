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

  console.log('✅ База данных инициализирована');
});

// Email конфигурация
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Проверка подключения к email
transporter.verify((error, success) => {
  if (error) {
    console.log('❌ Ошибка подключения к email:', error.message);
    console.log('🔍 Проверь: 1) EMAIL_USER 2) EMAIL_PASS (App Password) 3) 2FA включена');
  } else {
    console.log('✅ Email сервер готов к отправке');
  }
});

// ✅ API: Получить все заявки (для приложения)
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

// ✅ API: Получить все карьерные треки
app.get('/api/tracks', (req, res) => {
  db.all('SELECT name FROM career_tracks', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ tracks: rows.map(r => r.name) });
  });
});

// ✅ API: Подать заявку
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

// ✅ API: Пригласить на собеседование
app.post('/api/interview/:id', (req, res) => {
  const { id } = req.params;
  
  console.log(`📅 Приглашение на собеседование: ID ${id}`);
  
  db.get('SELECT * FROM applications WHERE id = ?', [id], (err, row) => {
    if (err || !row) {
      console.log('❌ Заявка не найдена');
      return res.status(404).json({ error: 'Заявка не найдена' });
    }

    db.run('UPDATE applications SET status = ? WHERE id = ?', ['interviewing', id], (err) => {
      if (err) {
        console.error('❌ Ошибка обновления статуса:', err);
        return res.status(500).json({ error: err.message });
      }

      console.log(`📧 Отправляю email на: ${row.email}`);

      const mailOptions = {
        from: `"HIWork HR" <${process.env.EMAIL_USER}>`,
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

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.log('❌ Ошибка отправки email:', error.message);
          console.log('🔍 Детали:', JSON.stringify(error, null, 2));
        } else {
          console.log('✅ Email отправлен:', info.response);
        }
      });

      console.log('✅ Статус обновлён: собеседование');
      res.json({ success: true, message: 'Статус обновлён: собеседование' });
    });
  });
});

// ✅ API: Принять на работу + QR код
app.post('/api/hire/:id', async (req, res) => {
  const { id } = req.params;
  
  console.log(`🎉 Принятие на работу: ID ${id}`);
  
  db.get('SELECT * FROM applications WHERE id = ?', [id], (err, row) => {
    if (err || !row) {
      console.log('❌ Заявка не найдена');
      return res.status(404).json({ error: 'Заявка не найдена' });
    }

    // Генерация одноразового QR кода
    const qrData = `HIWORK_HIRE_${id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    QRCode.toDataURL(qrData, async (err, qrCodeUrl) => {
      if (err) {
        console.error('❌ Ошибка генерации QR:', err);
        return res.status(500).json({ error: 'Ошибка генерации QR' });
      }

      db.run('UPDATE applications SET status = ?, qr_code = ? WHERE id = ?', ['hired', qrData, id], async (err) => {
        if (err) {
          console.error('❌ Ошибка обновления статуса:', err);
          return res.status(500).json({ error: err.message });
        }

        console.log(`📧 Отправляю email с QR кодом на: ${row.email}`);

        const mailOptions = {
          from: `"HIWork HR" <${process.env.EMAIL_USER}>`,
          to: row.email,
          subject: 'Поздравляем! Вы приняты на работу - HIWorkForHR',
          html: `
            <h2>Здравствуйте, ${row.full_name}!</h2>
            <p>Поздравляем! Вы приняты на работу на позицию <strong>${row.career_track}</strong>.</p>
            <p>Ваш персональный QR-код для регистрации:</p>
            <img src="${qrCodeUrl}" alt="QR Code" style="width: 200px; height: 200px; border: 2px solid #7B8CFF; border-radius: 8px;" />
            <p><em>Этот QR-код одноразовый и действителен только для первой регистрации.</em></p>
            <br>
            <p>С уважением,<br>Команда HIWorkForHR</p>
          `
        };

        try {
          await transporter.sendMail(mailOptions);
          console.log('✅ Email с QR отправлен');
          res.json({ success: true, message: 'Сотрудник принят, QR отправлен', qrCode: qrCodeUrl });
        } catch (error) {
          console.log('⚠️ Сотрудник принят, но email не отправлен:', error.message);
          res.json({ success: true, message: 'Сотрудник принят, но email не отправлен', qrCode: qrCodeUrl });
        }
      });
    });
  });
});

// ✅ API: Добавить карьерный трек
app.post('/api/tracks', (req, res) => {
  const { name } = req.body;
  db.run('INSERT OR IGNORE INTO career_tracks (name) VALUES (?)', [name], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    console.log(`✅ Трек добавлен: ${name}`);
    res.json({ success: true, message: 'Трек добавлен' });
  });
});

// ✅ API: Тест отправки email
app.get('/api/test-email', (req, res) => {
  const testEmail = req.query.to || process.env.EMAIL_USER;
  
  console.log(`🧪 Тест отправки email на: ${testEmail}`);
  
  const mailOptions = {
    from: `"HIWork HR" <${process.env.EMAIL_USER}>`,
    to: testEmail,
    subject: '🧪 Тест: отправка работает!',
    html: `
      <h2>Привет!</h2>
      <p>Если ты видишь это письмо — отправка работает! ✅</p>
      <p><strong>Кому:</strong> ${testEmail}</p>
      <p><strong>От:</strong> ${process.env.EMAIL_USER}</p>
      <hr>
      <small>HIWorkForHR • ${new Date().toLocaleString('ru-RU')}</small>
    `
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log('❌ Ошибка отправки:', error.message);
      console.log('🔍 Полная ошибка:', JSON.stringify(error, null, 2));
      res.json({ 
        success: false, 
        error: error.message,
        hint: 'Проверь: 1) App Password 2) 2FA включена 3) папку Спам'
      });
    } else {
      console.log('✅ Письмо отправлено:', info.response);
      res.json({ 
        success: true, 
        message: 'Письмо отправлено!',
        to: testEmail,
        info: info.response
      });
    }
  });
});

// ✅ Главная страница
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

// ✅ Проверка работоспособности
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    email_configured: !!process.env.EMAIL_USER
  });
});

// 🚀 Запуск сервера
const serverPort = PORT;

app.listen(serverPort, '0.0.0.0', () => {
  console.log('🚀 ============================================');
  console.log(`🚀 Сервер запущен на порту ${serverPort}`);
  console.log(`🚀 URL: https://hiwork-hiring-site.onrender.com`);
  console.log(`🚀 API: https://hiwork-hiring-site.onrender.com/api/applications`);
  console.log('🚀 ============================================');
  console.log('📧 Email отправитель:', process.env.EMAIL_USER || 'НЕ НАСТРОЕН');
  console.log('🔍 Для теста: /api/test-email');
  console.log('🚀 ============================================');
});

// Обработка ошибок
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
});
