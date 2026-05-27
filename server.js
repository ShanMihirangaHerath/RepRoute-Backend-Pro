require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const mammoth = require('mammoth');
const axios = require('axios');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

const app = express();
app.use(cors());
app.use(express.json()); 

const pool = mysql.createPool({
  host: '157.230.244.87',
  user: 'rep_user', 
  password: 'RepAdmin@123', 
  database: 'rep_management_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const upload = multer({ storage: multer.memoryStorage() });

function extractDataFromText(text) {
  const lines = text.split('\n');
  const extracted = [];
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    const phoneMatch = line.match(/\b0\d{9}\b|\b\d{3}[-.\s]?\d{4}[-.\s]?\d{3}\b/);
    const phone = phoneMatch ? phoneMatch[0] : null;
    let name = line;
    if (phone) name = line.replace(phone, '').trim();
    name = name.replace(/^[,-\s]+|[,-\s]+$/g, '').trim(); 
    if (name.length > 2) extracted.push({ Name: name, Contact: phone || 'No Number' });
  }
  return extracted;
}

app.post('/api/preview-locations', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const originalName = req.file.originalname.toLowerCase();
    
    let locations = [];
    
    if (originalName.endsWith('.xlsx') || originalName.endsWith('.xls') || originalName.endsWith('.csv')) {
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
      let startIndex = 0;
      if (rawData.length > 0 && typeof rawData[0][0] === 'string' && (rawData[0][0].toLowerCase().includes('name') || rawData[0][0].toLowerCase().includes('pharmacy'))) {
         startIndex = 1; 
      }
      for (let i = startIndex; i < rawData.length; i++) {
        const row = rawData[i];
        if (row && row.length > 0 && row[0]) {
          locations.push({ Name: String(row[0]).trim(), Contact: row[1] ? String(row[1]).trim() : 'No Number' });
        }
      }
    } else if (originalName.endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      locations = extractDataFromText(result.value);
    } else {
      return res.status(400).json({ message: 'Unsupported file type.' });
    }

    const processedLocations = [];
    for (const loc of locations) {
      const searchQuery = encodeURIComponent(`${loc.Name}, Sri Lanka`);
      try {
        const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${searchQuery}&key=${apiKey}`;
        const geoRes = await axios.get(geoUrl);
        if (geoRes.data.status === 'OK') {
          const { lat, lng } = geoRes.data.results[0].geometry.location;
          processedLocations.push({ ...loc, latitude: lat, longitude: lng, status: 'Found' });
        } else {
          processedLocations.push({ ...loc, latitude: null, longitude: null, status: 'Not Found' });
        }
      } catch (err) {
        processedLocations.push({ ...loc, latitude: null, longitude: null, status: 'Error' });
      }
    }

    const uniqueLocations = processedLocations.filter((v, i, a) => a.findIndex(t => (t.Name === v.Name)) === i);
    res.status(200).json({ data: uniqueLocations });

  } catch (error) {
    res.status(500).json({ message: 'Error processing the document' });
  }
});

app.post('/api/confirm-locations', async (req, res) => {
  try {
    const { repId, locations } = req.body;
    
    if (!repId || !locations || locations.length === 0) {
      return res.status(400).json({ message: 'Invalid data provided for saving.' });
    }

    let savedCount = 0;
    const today = new Date().toISOString().split('T')[0];

    for (const loc of locations) {
      if (loc.latitude && loc.longitude) {
        try {
          const [existingRows] = await pool.query('SELECT id FROM target_locations WHERE name = ? LIMIT 1', [loc.Name]);
          let locationId;
          
          if (existingRows.length > 0) {
            locationId = existingRows[0].id;
          } else {
            const [insertResult] = await pool.query(
              'INSERT INTO target_locations (name, contact, latitude, longitude) VALUES (?, ?, ?, ?)',
              [loc.Name, loc.Contact, loc.latitude, loc.longitude]
            );
            locationId = insertResult.insertId;
          }

          const [assignCheck] = await pool.query(
            'SELECT id FROM rep_assignments WHERE rep_id = ? AND location_id = ? AND assigned_date = ?',
            [repId, locationId, today]
          );

          if (assignCheck.length === 0) {
            await pool.query(
              'INSERT INTO rep_assignments (rep_id, location_id, assigned_date, status) VALUES (?, ?, ?, ?)',
              [repId, locationId, today, 'Pending']
            );
            savedCount++;
          }
        } catch (dbErr) {
          console.error(`DB Error:`, dbErr.message);
        }
      }
    }
    res.status(200).json({ message: `Successfully saved and assigned ${savedCount} locations!` });

  } catch (error) {
    res.status(500).json({ message: 'Error saving locations to database.' });
  }
});

app.get('/api/reps', async (req, res) => {
  try {
    const [reps] = await pool.query('SELECT id, first_name, last_name, email, username, mobile_number, whatsapp_number, nic_number, address, bank_account, created_at FROM users WHERE role = "rep" ORDER BY created_at DESC');
    res.status(200).json(reps);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching representatives' });
  }
});

app.post('/api/reps', async (req, res) => {
  try {
    const { first_name, last_name, email, username, password, mobile_number, whatsapp_number, nic_number, address, bank_account } = req.body;
    
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existing.length > 0) return res.status(400).json({ message: 'Username or Email already exists!' });

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    await pool.query(
      'INSERT INTO users (first_name, last_name, email, username, password, role, mobile_number, whatsapp_number, nic_number, address, bank_account) VALUES (?, ?, ?, ?, ?, "rep", ?, ?, ?, ?, ?)',
      [first_name, last_name, email, username, hashedPassword, mobile_number, whatsapp_number, nic_number, address, bank_account]
    );
    res.status(201).json({ message: 'Rep created successfully!' });
  } catch (error) {
    res.status(500).json({ message: 'Error creating representative' });
  }
});

app.put('/api/reps/:id', async (req, res) => {
  try {
    const repId = req.params.id;
    const { first_name, last_name, email, username, password, mobile_number, whatsapp_number, nic_number, address, bank_account } = req.body;
    
    if (password && password.trim() !== "") {
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      await pool.query(
        'UPDATE users SET first_name=?, last_name=?, email=?, username=?, password=?, mobile_number=?, whatsapp_number=?, nic_number=?, address=?, bank_account=? WHERE id=?',
        [first_name, last_name, email, username, hashedPassword, mobile_number, whatsapp_number, nic_number, address, bank_account, repId]
      );
    } else {
      await pool.query(
        'UPDATE users SET first_name=?, last_name=?, email=?, username=?, mobile_number=?, whatsapp_number=?, nic_number=?, address=?, bank_account=? WHERE id=?',
        [first_name, last_name, email, username, mobile_number, whatsapp_number, nic_number, address, bank_account, repId]
      );
    }
    
    res.status(200).json({ message: 'Rep updated successfully!' });
  } catch (error) {
    res.status(500).json({ message: 'Error updating representative' });
  }
});

// ==========================================
// 🚀 DASHBOARD REAL STATS API (CURDATE Fix)
// ==========================================
app.get('/api/dashboard-stats', async (req, res) => {
  try {
    const [reps] = await pool.query('SELECT COUNT(*) as count FROM users WHERE role="rep"');
    const [locations] = await pool.query('SELECT COUNT(*) as count FROM target_locations');
    
    // සම්පූර්ණ අසයින් කරපු ගාණ (CURDATE අයින් කළා)
    const [assignments] = await pool.query('SELECT COUNT(*) as count FROM rep_assignments');
    const [completed] = await pool.query('SELECT COUNT(*) as count FROM rep_assignments WHERE status="Visited"');
    
    // Reps ලාගේ සම්පූර්ණ ප්‍රගතිය (CURDATE අයින් කළා)
    const [repStats] = await pool.query(`
      SELECT u.id, u.first_name, u.last_name, 
             COUNT(ra.id) as total_assigned,
             SUM(CASE WHEN ra.status = 'Visited' THEN 1 ELSE 0 END) as completed
      FROM users u
      LEFT JOIN rep_assignments ra ON u.id = ra.rep_id
      WHERE u.role = 'rep'
      GROUP BY u.id
    `);

    // අන්තිම දවස් 7 Chart එක
    const [chartData] = await pool.query(`
      SELECT DATE_FORMAT(assigned_date, '%a') as name, COUNT(*) as visited 
      FROM rep_assignments 
      WHERE status = 'Visited' AND assigned_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY assigned_date ORDER BY assigned_date ASC
    `);

    res.status(200).json({
      activeReps: reps[0].count,
      totalLocations: locations[0].count,
      todaysVisits: assignments[0].count,
      completedVisits: completed[0].count,
      repStats: repStats,
      chartData: chartData.length > 0 ? chartData : [{ name: 'No Data', visited: 0 }]
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching stats' });
  }
});

// ==========================================
// 🚀 LIVE MAP & TRACKING API (CURDATE Fix & Latest Status)
// ==========================================
app.get('/api/map-data/:repId', async (req, res) => {
  try {
    const repId = req.params.repId; 
    const today = new Date().toISOString().split('T')[0];

    // All Reps
    if (repId === 'all') {
      const [allTargets] = await pool.query('SELECT id, name, contact, latitude, longitude, category FROM target_locations WHERE latitude IS NOT NULL');
      return res.status(200).json({ targets: allTargets, route: [] });
    }

    // 🚀 CURDATE අයින් කළා. කඩවල් ඔක්කොම පෙන්වනවා අන්තිම Status එකත් එක්ක!
    const [targets] = await pool.query(`
      SELECT tl.id, tl.name, tl.contact, tl.latitude, tl.longitude, ra.status, ra.is_unassigned,
             (SELECT status FROM visit_logs WHERE assignment_id = ra.id ORDER BY created_at DESC LIMIT 1) as latest_status
      FROM target_locations tl
      JOIN rep_assignments ra ON tl.id = ra.location_id
      WHERE ra.rep_id = ? AND tl.latitude IS NOT NULL
    `, [repId]);

    const [tracking] = await pool.query(`
      SELECT latitude, longitude FROM rep_tracking 
      WHERE rep_id = ? AND DATE(tracked_at) = ? ORDER BY tracked_at ASC
    `, [repId, today]);

    const route = tracking.map(t => [Number(t.latitude), Number(t.longitude)]);

    res.status(200).json({ targets: targets, route: route });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching map data' });
  }
});

app.get('/api/reps/:id/history', async (req, res) => {
  try {
    const repId = req.params.id;
    const [history] = await pool.query(`
      SELECT ra.id as assignment_id, tl.name AS location_name, tl.latitude, tl.longitude, 
             DATE_FORMAT(ra.assigned_date, '%Y-%m-%d') as assigned_date, ra.status as assignment_status, ra.is_unassigned,
             vl.id as log_id, vl.met_person, vl.contact_number, vl.status as log_status, vl.notes, vl.created_at,
             vl.latitude as log_lat, vl.longitude as log_lng
      FROM rep_assignments ra
      JOIN target_locations tl ON ra.location_id = tl.id
      LEFT JOIN visit_logs vl ON ra.id = vl.assignment_id
      WHERE ra.rep_id = ?
      ORDER BY ra.assigned_date DESC, vl.created_at DESC
    `, [repId]);

    const groupedHistory = [];
    const map = new Map();
    
    for (const row of history) {
      if (!map.has(row.assignment_id)) {
        map.set(row.assignment_id, {
          id: row.assignment_id, location_name: row.location_name, latitude: row.latitude, longitude: row.longitude,
          assigned_date: row.assigned_date, status: row.assignment_status, is_unassigned: row.is_unassigned, logs: []
        });
        groupedHistory.push(map.get(row.assignment_id));
      }
      if (row.log_id) {
        map.get(row.assignment_id).logs.push({
          id: row.log_id, met_person: row.met_person, contact_number: row.contact_number, status: row.log_status, notes: row.notes, 
          created_at: row.created_at, log_lat: row.log_lat, log_lng: row.log_lng
        });
      }
    }
    res.status(200).json(groupedHistory);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching representative history' });
  }
});

// ==========================================
// APPROVALS APIs (Leaves, Expenses, Salary)
// ==========================================

app.get('/api/admin/leaves', async (req, res) => {
  try {
    const [leaves] = await pool.query(`SELECT l.*, u.first_name, u.last_name FROM leave_requests l JOIN users u ON l.rep_id = u.id ORDER BY l.created_at DESC`);
    res.json(leaves);
  } catch(e) { res.status(500).json({message: 'Error fetching leaves'}); }
});

app.put('/api/admin/leaves/:id', async (req, res) => {
  try {
    await pool.query('UPDATE leave_requests SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
    res.json({message: 'Leave updated successfully'});
  } catch(e) { res.status(500).json({message: 'Error updating leave'}); }
});

app.get('/api/admin/expenses', async (req, res) => {
  try {
    const [expenses] = await pool.query(`SELECT e.*, u.first_name, u.last_name FROM expenses e JOIN users u ON e.rep_id = u.id ORDER BY e.created_at DESC`);
    res.json(expenses);
  } catch(e) { res.status(500).json({message: 'Error fetching expenses'}); }
});

app.put('/api/admin/expenses/:id', async (req, res) => {
  try {
    await pool.query('UPDATE expenses SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
    res.json({message: 'Expense updated successfully'});
  } catch(e) { res.status(500).json({message: 'Error updating expense'}); }
});

app.get('/api/admin/salaries', async (req, res) => {
  try {
    const [salaries] = await pool.query(`
      SELECT s.id, s.amount, s.status, u.first_name, u.last_name, u.bank_account, 
             DATE_FORMAT(s.requested_at, '%Y-%m-%d') as req_date
      FROM salary_requests s JOIN users u ON s.rep_id = u.id ORDER BY s.requested_at DESC
    `);
    res.json(salaries);
  } catch(e) { res.status(500).json({message: 'Error fetching salaries'}); }
});

app.put('/api/admin/salaries/:id', async (req, res) => {
  try {
    if(req.body.status === 'Paid') {
      await pool.query('UPDATE salary_requests SET status = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?', [req.body.status, req.params.id]);
    } else {
      await pool.query('UPDATE salary_requests SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
    }
    res.json({message: 'Salary status updated'});
  } catch(e) { res.status(500).json({message: 'Error updating salary'}); }
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend Server is running on http://localhost:${PORT}`);
});