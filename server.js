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

// 🚀 UPDATE: Confirm Locations API (Added Category Support)
app.post('/api/confirm-locations', async (req, res) => {
  try {
    const { repId, locations, category } = req.body; // 👈 අලුතින් category එක ගත්තා
    
    if (!repId || !locations || locations.length === 0) {
      return res.status(400).json({ message: 'Invalid data provided for saving.' });
    }

    const locCategory = category || 'Pharmacy'; // 👈 මුකුත් නැත්තම් Pharmacy කියලා වැටෙනවා
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
            // 👈 අලුතින් Category එක Database එකට සේව් කරනවා
            const [insertResult] = await pool.query(
              'INSERT INTO target_locations (name, contact, latitude, longitude, category) VALUES (?, ?, ?, ?, ?)',
              [loc.Name, loc.Contact, loc.latitude, loc.longitude, locCategory]
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

app.get('/api/dashboard-stats', async (req, res) => {
  try {
    const filterDate = req.query.date; 
    
    const [reps] = await pool.query('SELECT COUNT(*) as count FROM users WHERE role="rep"');
    const [locations] = await pool.query('SELECT COUNT(*) as count FROM target_locations');
    
    let assignments, completed, repStats;

    if (filterDate && filterDate !== 'all') {
      [assignments] = await pool.query('SELECT COUNT(*) as count FROM rep_assignments WHERE assigned_date = ?', [filterDate]);
      [completed] = await pool.query('SELECT COUNT(DISTINCT assignment_id) as count FROM visit_logs WHERE DATE(created_at) = ?', [filterDate]);
      
      [repStats] = await pool.query(`
        SELECT u.id, u.first_name, u.last_name, 
               (SELECT COUNT(*) FROM rep_assignments WHERE rep_id = u.id AND assigned_date = ?) as total_assigned,
               (SELECT COUNT(DISTINCT assignment_id) FROM visit_logs WHERE assignment_id IN (SELECT id FROM rep_assignments WHERE rep_id = u.id) AND DATE(created_at) = ?) as completed
        FROM users u
        WHERE u.role = 'rep'
      `, [filterDate, filterDate]);
    } else {
      [assignments] = await pool.query('SELECT COUNT(*) as count FROM rep_assignments');
      [completed] = await pool.query('SELECT COUNT(DISTINCT assignment_id) as count FROM visit_logs');
      
      [repStats] = await pool.query(`
        SELECT u.id, u.first_name, u.last_name, 
               (SELECT COUNT(*) FROM rep_assignments WHERE rep_id = u.id) as total_assigned,
               (SELECT COUNT(DISTINCT assignment_id) FROM visit_logs WHERE assignment_id IN (SELECT id FROM rep_assignments WHERE rep_id = u.id)) as completed
        FROM users u
        WHERE u.role = 'rep'
      `);
    }

    let chartEndDate = filterDate && filterDate !== 'all' ? filterDate : new Date().toISOString().split('T')[0];
    const [chartData] = await pool.query(`
      SELECT DATE_FORMAT(assigned_date, '%a') as name, COUNT(*) as visited 
      FROM rep_assignments 
      WHERE status = 'Visited' AND assigned_date >= DATE_SUB(?, INTERVAL 7 DAY) AND assigned_date <= ?
      GROUP BY assigned_date ORDER BY assigned_date ASC
    `, [chartEndDate, chartEndDate]);

    res.status(200).json({
      activeReps: reps[0].count,
      totalLocations: locations[0].count,
      todaysVisits: assignments[0].count,
      completedVisits: completed[0].count,
      repStats: repStats,
      chartData: chartData.length > 0 ? chartData : [{ name: 'No Data', visited: 0 }]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error fetching stats' });
  }
});

// ==========================================
// 🚀 LIVE MAP & TRACKING API (FIXED ROUTE & LOCATIONS)
// ==========================================
app.get('/api/map-data/:repId', async (req, res) => {
  try {
    const repId = req.params.repId; 
    const filterDate = req.query.date;
    const today = new Date().toISOString().split('T')[0];

    if (repId === 'all') {
      const [allTargets] = await pool.query('SELECT id, name, contact, latitude, longitude, category FROM target_locations WHERE latitude IS NOT NULL');
      return res.status(200).json({ targets: allTargets, routes: [] });
    }

    // 1. 📍 Locations (කඩවල්): දවසක් තේරුවත් නැතත් ඔක්කොම පෙන්වනවා
    const [targets] = await pool.query(`
      SELECT tl.id, tl.name, tl.contact, tl.latitude, tl.longitude, ra.status, ra.is_unassigned, DATE_FORMAT(ra.assigned_date, '%Y-%m-%d') as assigned_date,
             (SELECT status FROM visit_logs WHERE assignment_id = ra.id ORDER BY created_at DESC LIMIT 1) as latest_status
      FROM target_locations tl
      JOIN rep_assignments ra ON tl.id = ra.location_id
      WHERE ra.rep_id = ? AND tl.latitude IS NOT NULL
    `, [repId]);

    // 2. 🟢 Route Data Grouping (දවස අනුව පාරවල් කඩලා ගන්නවා)
    let routes = [];

    if (filterDate && filterDate !== 'all') {
      // දවසක් තේරුවම ඒ දවසේ පාර විතරක් (කොළ පාටින් එයි)
      const [tracking] = await pool.query(`
        SELECT latitude, longitude FROM rep_tracking 
        WHERE rep_id = ? AND DATE(tracked_at) = ? ORDER BY tracked_at ASC
      `, [repId, filterDate]);
      
      if (tracking.length > 0) {
        routes.push({
          date: filterDate,
          isToday: filterDate === today,
          path: tracking.map(t => [Number(t.latitude), Number(t.longitude)])
        });
      }
    } else {
      // All Time දැම්මම ඔක්කොම දවස් වල පාරවල් ගන්නවා (Group by Date)
      const [tracking] = await pool.query(`
        SELECT latitude, longitude, DATE(tracked_at) as t_date FROM rep_tracking 
        WHERE rep_id = ? ORDER BY tracked_at ASC
      `, [repId]);

      // දවස් අනුව පාරවල් Array එකකට දානවා
      const groupedPaths = {};
      tracking.forEach(t => {
        if (!groupedPaths[t.t_date]) groupedPaths[t.t_date] = [];
        groupedPaths[t.t_date].push([Number(t.latitude), Number(t.longitude)]);
      });

      for (const [dateKey, path] of Object.entries(groupedPaths)) {
        routes.push({
          date: dateKey,
          isToday: dateKey === today, // අද දවස නම් true (කොළ පාට වෙන්න)
          path: path
        });
      }
    }

    res.status(200).json({ targets: targets, routes: routes });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error fetching map data' });
  }
});


app.get('/api/reps/:id/history', async (req, res) => {
  try {
    const repId = req.params.id;
    const filterDate = req.query.date;
    
    let dateCondition = "";
    let queryParams = [repId];

    if (filterDate && filterDate !== 'all') {
      dateCondition = "AND (ra.assigned_date = ? OR DATE(vl.created_at) = ?)";
      queryParams.push(filterDate, filterDate);
    }

    const [history] = await pool.query(`
      SELECT ra.id as assignment_id, tl.name AS location_name, tl.latitude, tl.longitude, 
             DATE_FORMAT(ra.assigned_date, '%Y-%m-%d') as assigned_date, ra.status as assignment_status, ra.is_unassigned,
             vl.id as log_id, vl.met_person, vl.contact_number, vl.status as log_status, vl.notes, vl.created_at,
             vl.latitude as log_lat, vl.longitude as log_lng
      FROM rep_assignments ra
      JOIN target_locations tl ON ra.location_id = tl.id
      LEFT JOIN visit_logs vl ON ra.id = vl.assignment_id
      WHERE ra.rep_id = ? ${dateCondition}
      ORDER BY ra.assigned_date DESC, vl.created_at DESC
    `, queryParams);

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
    console.error(error);
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

// 🚀 1. PDF Report Generation (Specific Rep)
app.get('/api/admin/report/:repId', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT ra.assigned_date, tl.name as store, vl.status, vl.met_person, vl.notes 
            FROM rep_assignments ra
            JOIN target_locations tl ON ra.location_id = tl.id
            LEFT JOIN visit_logs vl ON ra.id = vl.assignment_id
            WHERE ra.rep_id = ?
        `, [req.params.repId]);
        res.json(rows);
    } catch(e) { res.status(500).json({message: 'Report generation failed'}); }
});

// 🚀 2. Send Message to Reps (Group or Single)
app.post('/api/admin/send-message', async (req, res) => {
    const { repIds, message } = req.body; // repIds = [1, 2, 3] wage array ekk
    try {
        for (let id of repIds) {
            await pool.query('INSERT INTO messages (rep_id, sender, message) VALUES (?, "admin", ?)', [id, message]);
        }
        res.json({message: 'Messages sent successfully'});
    } catch(e) { res.status(500).json({message: 'Failed to send messages'}); }
});

app.get('/api/admin/messages/:repId', async (req, res) => {
    try {
        const [messages] = await pool.query('SELECT * FROM messages WHERE rep_id = ? ORDER BY created_at ASC', [req.params.repId]);
        res.json(messages);
    } catch(e) { res.status(500).json({message: 'Failed to fetch messages'}); }
});

// ==========================================
// 🚀 ADVANCED FULL REPORT API
// ==========================================
app.get('/api/admin/full-report', async (req, res) => {
  try {
    const { startDate, endDate, repId, status } = req.query;

    let query = `
      SELECT 
        vl.id as log_id,
        vl.created_at as visit_date,
        u.first_name, u.last_name,
        tl.name as shop_name, tl.contact as shop_contact, tl.category,
        vl.met_person, vl.contact_number as person_contact,
        vl.status, vl.notes,
        ra.is_unassigned, DATE_FORMAT(ra.assigned_date, '%Y-%m-%d') as assigned_date
      FROM visit_logs vl
      JOIN rep_assignments ra ON vl.assignment_id = ra.id
      JOIN target_locations tl ON ra.location_id = tl.id
      JOIN users u ON ra.rep_id = u.id
      WHERE 1=1
    `;
    const params = [];

    // 1. Date Range Filter
    if (startDate && startDate !== 'all') {
      query += ` AND DATE(vl.created_at) >= ?`;
      params.push(startDate);
    }
    if (endDate && endDate !== 'all') {
      query += ` AND DATE(vl.created_at) <= ?`;
      params.push(endDate);
    }
    
    // 2. Rep Filter
    if (repId && repId !== 'all') {
      query += ` AND ra.rep_id = ?`;
      params.push(repId);
    }

    // 3. Status Filter
    if (status && status !== 'all') {
      query += ` AND vl.status = ?`;
      params.push(status);
    }

    query += ` ORDER BY vl.created_at DESC`;

    const [rows] = await pool.query(query, params);
    res.status(200).json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error fetching report data' });
  }
});

// ==========================================
// 🚀 SALARY MANAGEMENT APIs (Admin Side)
// ==========================================
app.get('/api/admin/salary-balances', async (req, res) => {
  try {
      const [reps] = await pool.query('SELECT id, first_name, last_name, base_salary, available_salary, advance_taken, penalty_amount FROM users WHERE role="rep"');
      res.json(reps);
  } catch(e) { res.status(500).json({message: 'Error fetching balances'}); }
});

app.post('/api/admin/set-base-salary', async (req, res) => {
  const { rep_id, base_salary } = req.body;
  try {
      const [users] = await pool.query('SELECT base_salary FROM users WHERE id = ?', [rep_id]);
      const currentBase = parseFloat(users[0].base_salary || 0);

      if (currentBase === 0) {
          // මුල්ම පාරට පඩිය දානවා නම්, available එකටත් ඒ ගාණම දානවා
          await pool.query('UPDATE users SET base_salary=?, available_salary=? WHERE id=?', [base_salary, base_salary, rep_id]);
      } else {
          await pool.query('UPDATE users SET base_salary=? WHERE id=?', [base_salary, rep_id]);
      }
      res.json({ message: 'Base salary updated successfully!' });
  } catch(e) { res.status(500).json({message: 'Error updating base salary'}); }
});

app.post('/api/admin/settle-month', async (req, res) => {
  const { rep_id } = req.body;
  try {
      const [users] = await pool.query('SELECT base_salary, available_salary, advance_taken, penalty_amount FROM users WHERE id = ?', [rep_id]);
      const user = users[0];

      let base = parseFloat(user.base_salary || 0);
      let available = parseFloat(user.available_salary || 0); // මේක තමයි අතට දෙන්න ඕන ඉතුරු ගාණ
      let advance = parseFloat(user.advance_taken || 0);
      let penalty = parseFloat(user.penalty_amount || 0);

      // 🚀 ඊළඟ මාසේ පඩිය කැල්කියුලේට් කිරීම (Base එකෙන් Advance + Penalty අඩු කරනවා)
      let next_available = base - advance - penalty;
      let next_advance = 0;
      let next_penalty = 0;

      if (next_available < 0) {
          // පඩියටත් වඩා ණය නම්, ඒක ඊළඟ මාසෙටත් රෝල් වෙනවා
          next_advance = Math.abs(next_available);
          next_available = 0;
      }

      await pool.query(
          'UPDATE users SET available_salary=?, advance_taken=?, penalty_amount=? WHERE id=?',
          [next_available, next_advance, next_penalty, rep_id]
      );

      // Settle කරපු ගාණ Record එකක් විදිහට දානවා
      if (available > 0) {
          await pool.query(
              'INSERT INTO salary_requests (rep_id, amount, status, is_advance, penalty_applied) VALUES (?, ?, ?, ?, ?)',
              [rep_id, available, 'Paid', 0, 0] 
          );
      }

      res.json({ message: 'Month settled successfully!', netPayable: available });
  } catch(e) { res.status(500).json({message: 'Error settling month'}); }
});

// 4. Advanced Salary Reports API
app.get('/api/admin/salary-reports', async (req, res) => {
  const { startDate, endDate, repId } = req.query;
  let query = `
      SELECT s.id, s.amount, s.status, s.is_advance, s.penalty_applied, s.requested_at, u.first_name, u.last_name
      FROM salary_requests s JOIN users u ON s.rep_id = u.id WHERE 1=1
  `;
  const params = [];
  
  if (startDate && startDate !== 'all') { query += ` AND DATE(s.requested_at) >= ?`; params.push(startDate); }
  if (endDate && endDate !== 'all') { query += ` AND DATE(s.requested_at) <= ?`; params.push(endDate); }
  if (repId && repId !== 'all') { query += ` AND s.rep_id = ?`; params.push(repId); }
  
  query += ` ORDER BY s.requested_at DESC`;

  try {
      const [rows] = await pool.query(query, params);
      res.json(rows);
  } catch (e) { res.status(500).json({ message: 'Error fetching reports' }); }
});

// Update Request Status (Approve/Reject)
app.put('/api/admin/salary-requests/:id', async (req, res) => {
  try {
      const { status } = req.body;
      const reqId = req.params.id;
      if (status === 'Paid') {
          await pool.query('UPDATE salary_requests SET status = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?', [status, reqId]);
      } else {
          await pool.query('UPDATE salary_requests SET status = ? WHERE id = ?', [status, reqId]);
      }
      res.json({message: 'Request updated!'});
  } catch(e) { res.status(500).json({message: 'Error updating request'}); }
});

// app.post('/api/admin/update-salary-balance', async (req, res) => {
//   const { rep_id, added_amount } = req.body;
//   try {
//       const [users] = await pool.query('SELECT available_salary, advance_taken, penalty_amount FROM users WHERE id = ?', [rep_id]);
//       const user = users[0];
      
//       let advance = parseFloat(user.advance_taken || 0);
//       let penalty = parseFloat(user.penalty_amount || 0);
//       let available = parseFloat(user.available_salary || 0);
//       let addAmount = parseFloat(added_amount);

//       let total_deduction = advance + penalty;

//       // 🚀 කලින් ගත්ත Advance සහ 10% Penalty එක මේ මාසේ පඩියෙන් කැපෙනවා!
//       if (addAmount >= total_deduction) {
//           let net_add = addAmount - total_deduction;
//           available += net_add;
//           advance = 0;
//           penalty = 0;
//       } else {
//           let remaining = total_deduction - addAmount;
//           advance = remaining;
//           penalty = 0;
//       }

//       await pool.query('UPDATE users SET available_salary=?, advance_taken=?, penalty_amount=? WHERE id=?', [available, advance, penalty, rep_id]);
//       res.json({message: "Salary updated and deductions applied automatically!"});
//   } catch(e) { res.status(500).json({message: 'Error updating balance'}); }
// });

// ==========================================
// 🚀 ADMIN LOGIN & AUTHENTICATION APIs
// ==========================================

// Login API
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE username = ? AND role = "admin"', [username]);
    if (users.length === 0) return res.status(401).json({ message: 'Invalid username or not an admin!' });

    // 🚀 Check Password (bcrypt)
    const validPassword = await bcrypt.compare(password, users[0].password);
    if (!validPassword) return res.status(401).json({ message: 'Incorrect password!' });

    res.status(200).json({ message: 'Login successful', admin: { id: users[0].id, name: users[0].first_name } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// 🚀 Default Admin කෙනෙක් හදාගන්න Quick Setup API (එක පාරක් රන් කරන්න)
app.post('/api/admin/setup', async (req, res) => {
  try {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash('admin123', saltRounds);
    
    // Database එකේ admin කෙනෙක් නැත්තම් විතරක් හදනවා
    const [existing] = await pool.query('SELECT id FROM users WHERE username = "admin"');
    if (existing.length === 0) {
      await pool.query(
        'INSERT INTO users (first_name, last_name, username, password, role) VALUES (?, ?, ?, ?, ?)',
        ['Super', 'Admin', 'admin', hashedPassword, 'admin']
      );
      res.json({ message: 'Admin created successfully! Username: admin, Password: admin123' });
    } else {
      res.json({ message: 'Admin already exists!' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Setup failed' });
  }
});

// ==========================================
// 🚀 ADMIN SETTINGS APIs
// ==========================================

// 1. Get Admin Profile
app.get('/api/admin/settings/profile', async (req, res) => {
  try {
    const [users] = await pool.query('SELECT first_name, last_name, email, address as company_name FROM users WHERE role="admin" LIMIT 1');
    if (users.length > 0) res.json(users[0]);
    else res.status(404).json({ message: "Admin not found" });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
});

// 2. Update Admin Profile
app.put('/api/admin/settings/profile', async (req, res) => {
  try {
    const { first_name, last_name, email, company_name } = req.body;
    await pool.query(
      'UPDATE users SET first_name=?, last_name=?, email=?, address=? WHERE role="admin"', 
      [first_name, last_name, email, company_name]
    );
    res.json({ message: "Profile updated successfully!" });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
});

// 3. Update Admin Password
app.put('/api/admin/settings/password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const [users] = await pool.query('SELECT password FROM users WHERE role="admin" LIMIT 1');
    
    if (users.length === 0) return res.status(404).json({ message: "Admin not found" });

    // පරණ Password එක හරිද බලනවා
    const validPassword = await bcrypt.compare(current_password, users[0].password);
    if (!validPassword) return res.status(401).json({ message: "Incorrect current password!" });

    // අලුත් Password එක Hash කරලා සේව් කරනවා
    const hashedPassword = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password=? WHERE role="admin"', [hashedPassword]);
    
    res.json({ message: "Password updated successfully!" });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend Server is running on http://localhost:${PORT}`);
}); 