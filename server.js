require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const mammoth = require('mammoth');
const axios = require('axios');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json()); // JSON දත්ත ගන්න (Confirm API එකට ඕනේ)

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

// ---------------------------------------------------------
// API 1: ෆයිල් එක කියවලා Google ලොකේෂන් හොයලා Preview එකට යවනවා 
// (Database එකට සේව් කරන්නේ නැහැ)
// ---------------------------------------------------------
app.post('/api/preview-locations', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const originalName = req.file.originalname.toLowerCase();
    
    let locations = [];
    console.log(`\n📂 Generating PREVIEW for: ${originalName}`);

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
    console.log(`✅ Preview ready with ${uniqueLocations.length} locations. Sending to Frontend...`);
    
    res.status(200).json({ data: uniqueLocations });

  } catch (error) {
    console.error('❌ Server Error:', error);
    res.status(500).json({ message: 'Error processing the document' });
  }
});

// ---------------------------------------------------------
// API 2: Admin Confirm කරාට පස්සේ Database එකට සේව් කරනවා
// ---------------------------------------------------------
app.post('/api/confirm-locations', async (req, res) => {
  try {
    const { repId, locations } = req.body;
    
    if (!repId || !locations || locations.length === 0) {
      return res.status(400).json({ message: 'Invalid data provided for saving.' });
    }

    console.log(`\n💾 SAVING locations and assigning to Rep ID: ${repId}...`);
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
          console.error(`❌ DB Insert Error for ${loc.Name}:`, dbErr.message);
        }
      }
    }

    console.log(`🎉 Successfully assigned ${savedCount} locations!`);
    res.status(200).json({ message: `Successfully saved and assigned ${savedCount} locations!` });

  } catch (error) {
    console.error('❌ Save Error:', error);
    res.status(500).json({ message: 'Error saving locations to database.' });
  }
});

// ==========================================
// REP MANAGEMENT APIs
// ==========================================

// 1. ඔක්කොම Reps ලා අරන් එන්න (Get All Reps)
app.get('/api/reps', async (req, res) => {
  try {
    const [reps] = await pool.query('SELECT id, first_name, last_name, email, username, mobile_number, whatsapp_number, nic_number, address, bank_account, created_at FROM users WHERE role = "rep" ORDER BY created_at DESC');
    res.status(200).json(reps);
  } catch (error) {
    console.error('❌ Error fetching reps:', error);
    res.status(500).json({ message: 'Error fetching representatives' });
  }
});

// 2. අලුත් Rep කෙනෙක් දාන්න (Create New Rep)
app.post('/api/reps', async (req, res) => {
  try {
    const { first_name, last_name, email, username, password, mobile_number, whatsapp_number, nic_number, address, bank_account } = req.body;
    
    // Username එක හරි Email එක හරි කලින් තියෙනවද බලනවා
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existing.length > 0) return res.status(400).json({ message: 'Username or Email already exists!' });

    await pool.query(
      'INSERT INTO users (first_name, last_name, email, username, password, role, mobile_number, whatsapp_number, nic_number, address, bank_account) VALUES (?, ?, ?, ?, ?, "rep", ?, ?, ?, ?, ?)',
      [first_name, last_name, email, username, password, mobile_number, whatsapp_number, nic_number, address, bank_account]
    );
    res.status(201).json({ message: 'Rep created successfully!' });
  } catch (error) {
    console.error('❌ Error creating rep:', error);
    res.status(500).json({ message: 'Error creating representative' });
  }
});

// 3. Rep ගේ විස්තර අප්ඩේට් කරන්න (Update Rep)
app.put('/api/reps/:id', async (req, res) => {
  try {
    const repId = req.params.id;
    const { first_name, last_name, email, username, mobile_number, whatsapp_number, nic_number, address, bank_account } = req.body;
    
    await pool.query(
      'UPDATE users SET first_name=?, last_name=?, email=?, username=?, mobile_number=?, whatsapp_number=?, nic_number=?, address=?, bank_account=? WHERE id=?',
      [first_name, last_name, email, username, mobile_number, whatsapp_number, nic_number, address, bank_account, repId]
    );
    res.status(200).json({ message: 'Rep updated successfully!' });
  } catch (error) {
    console.error('❌ Error updating rep:', error);
    res.status(500).json({ message: 'Error updating representative' });
  }
});

// ==========================================
// DASHBOARD & MAP APIs (REAL DATA)
// ==========================================

// 1. Dashboard එකේ ප්‍රස්ථාර සහ ගණන් කිරීම් සඳහා
app.get('/api/dashboard-stats', async (req, res) => {
  try {
    const [reps] = await pool.query('SELECT COUNT(*) as count FROM users WHERE role="rep"');
    const [locations] = await pool.query('SELECT COUNT(*) as count FROM target_locations');
    const [assignments] = await pool.query('SELECT COUNT(*) as count FROM rep_assignments WHERE assigned_date = CURDATE()');
    
    // දැනට ප්‍රස්ථාර වලට අපි දවස් 6ක බොරු ඩේටා දෙනවා, පස්සේ Tracking ආවම ඇත්ත දාමු
    const repActivityData = [
      { name: 'Mon', visited: 10 }, { name: 'Tue', visited: 25 },
      { name: 'Wed', visited: 30 }, { name: 'Thu', visited: 40 },
      { name: 'Fri', visited: 20 }, { name: 'Sat', visited: 15 },
    ];

    res.status(200).json({
      activeReps: reps[0].count,
      totalLocations: locations[0].count,
      todaysVisits: assignments[0].count,
      avgStopTime: '0m', // තාම App එකෙන් ඩේටා එන්නේ නැති නිසා
      chartData: repActivityData
    });
  } catch (error) {
    console.error('❌ Error fetching dashboard stats:', error);
    res.status(500).json({ message: 'Error fetching stats' });
  }
});

// 2. Map එක සඳහා (අදාළ Rep ගේ ටාගට් සහ Route එක)
app.get('/api/map-data/:repId', async (req, res) => {
  try {
    const repId = req.params.id;
    const today = new Date().toISOString().split('T')[0];

    const [targets] = await pool.query(`
      SELECT tl.id, tl.name, tl.contact, tl.latitude, tl.longitude, ra.status, ra.met_person, ra.is_unassigned 
      FROM target_locations tl
      JOIN rep_assignments ra ON tl.id = ra.location_id
      WHERE ra.rep_id = ? AND ra.assigned_date = ?
    `, [repId, today]);

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
// 1. Rep kenekge mulo visit history eka ganna API eka
app.get('/api/reps/:id/history', async (req, res) => {
  try {
    const repId = req.params.id;
    const [history] = await pool.query(`
      SELECT ra.id, tl.name AS location_name, tl.contact, tl.latitude, tl.longitude, 
             ra.assigned_date, ra.status, ra.met_person, ra.visit_notes, ra.is_unassigned
      FROM rep_assignments ra
      JOIN target_locations tl ON ra.location_id = tl.id
      WHERE ra.rep_id = ?
      ORDER BY ra.assigned_date DESC
    `, [repId]);
    res.status(200).json(history);
  } catch (error) {
    console.error('❌ Error fetching rep history:', error);
    res.status(500).json({ message: 'Error fetching representative history' });
  }
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend Server is running on http://localhost:${PORT}`);
});