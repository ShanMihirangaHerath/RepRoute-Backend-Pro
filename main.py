from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import mysql.connector
import smtplib
from email.message import EmailMessage
import random
import bcrypt
from datetime import date

app = FastAPI()

SENDER_EMAIL = "familydoctorhealth@gmail.com"
APP_PASSWORD = "lkqm npoz qtqd sqf"

otp_storage = {}

# Database Connection
def get_db_connection():
    return mysql.connector.connect(
        host="localhost",
        user="rep_user",
        password="RepAdmin@123",
        database="rep_management_db"
    )

class OTPRequest(BaseModel):
    email: str

class RegisterRequest(BaseModel):
    first_name: str
    last_name: str
    email: str
    username: str
    password: str
    mobile_number: str
    whatsapp_number: str
    otp: str

class LoginRequest(BaseModel):
    username: str
    password: str

class LocationUpdate(BaseModel):
    rep_id: int
    latitude: float
    longitude: float

class TaskUpdate(BaseModel):
    assignment_id: int
    status: str
    met_person: str
    visit_notes: str

class UnplannedVisit(BaseModel):
    rep_id: int
    name: str
    contact: str
    category: str
    latitude: float
    longitude: float
    met_person: str
    visit_notes: str

def send_email(to_email: str, otp: str):
    msg = EmailMessage()
    msg.set_content(f"Welcome to Rep Route Pro!\n\nYour OTP for registration is: {otp}\n\nDo not share this code with anyone.")
    msg["Subject"] = "Rep Route Pro - Verification OTP"
    msg["From"] = SENDER_EMAIL
    msg["To"] = to_email

    try:
        server = smtplib.SMTP_SSL('smtp.gmail.com', 465)
        server.login(SENDER_EMAIL, APP_PASSWORD)
        server.send_message(msg)
        server.quit()
        return True
    except Exception as e:
        print(f"SMTP Error from DigitalOcean: {e}")
        return False

@app.get("/")
def read_root():
    return {"message": "Rep Route API is Running Successfully!"}

@app.post("/send-otp")
def send_otp(req: OTPRequest):
    otp = str(random.randint(100000, 999999))
    print(f"\n=============================================")
    print(f"🚨 DEBUG: OTP FOR {req.email} IS: {otp} 🚨")
    print(f"=============================================\n")
    
    is_sent = send_email(req.email, otp)
    otp_storage[req.email] = otp
    
    if is_sent:
        return {"message": "OTP sent to email successfully!"}
    else:
        return {"message": "Email blocked by DO, but OTP saved in Server Terminal."}

@app.post("/register")
def register(req: RegisterRequest):
    if otp_storage.get(req.email) != req.otp:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP!")

    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT * FROM users WHERE username = %s", (req.username,))
    if cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=400, detail="Username already exists!")

    cursor.execute("SELECT * FROM users WHERE email = %s", (req.email,))
    if cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=400, detail="Email is already registered!")

    hashed_pw = bcrypt.hashpw(req.password.encode('utf-8'), bcrypt.gensalt())

    try:
        cursor.execute("""
            INSERT INTO users (first_name, last_name, email, username, password, mobile_number, whatsapp_number)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (req.first_name, req.last_name, req.email, req.username, hashed_pw.decode('utf-8'), req.mobile_number, req.whatsapp_number))
        conn.commit()
        del otp_storage[req.email]
        return {"message": "User registered successfully!"}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail="Database error")
    finally:
        conn.close()

@app.post("/login")
def login(req: LoginRequest):
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT * FROM users WHERE username = %s", (req.username,))
    user = cursor.fetchone()
    conn.close()

    if not user or not bcrypt.checkpw(req.password.encode('utf-8'), user['password'].encode('utf-8')):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    return {
        "message": "Login successful!", 
        "user": {
            "id": user["id"],  
            "first_name": user["first_name"], 
            "last_name": user["last_name"], 
            "username": user["username"]
        }
    }

@app.post("/update-location")
def update_location(req: LocationUpdate):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            INSERT INTO rep_tracking (rep_id, latitude, longitude)
            VALUES (%s, %s, %s)
        """, (req.rep_id, req.latitude, req.longitude))
        conn.commit()
        return {"message": "Location updated successfully"}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

# 🚀 අලුතින් එකතු කරපු "Tasks" API එක 
@app.get("/tasks/{rep_id}")
def get_daily_tasks(rep_id: int):
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        # අද දවසට අදාළව මේ Rep ට දීලා තියෙන Target Locations ටික ගන්නවා
        query = """
            SELECT ra.id as assignment_id, ra.status, tl.id as location_id, 
                   tl.name as store_name, tl.contact, tl.latitude, tl.longitude 
            FROM rep_assignments ra 
            JOIN target_locations tl ON ra.location_id = tl.id 
            WHERE ra.rep_id = %s AND ra.assigned_date = CURDATE()
        """
        cursor.execute(query, (rep_id,))
        tasks = cursor.fetchall()
        return {"tasks": tasks}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


@app.post("/update-task")
def update_task(req: TaskUpdate):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            UPDATE rep_assignments 
            SET status = %s, met_person = %s, visit_notes = %s 
            WHERE id = %s
        """, (req.status, req.met_person, req.visit_notes, req.assignment_id))
        conn.commit()
        return {"message": "Task updated successfully"}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


@app.post("/add-unplanned-visit")
def add_unplanned_visit(req: UnplannedVisit):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # 1. මුලින්ම අලුත් කඩේ target_locations එකට සේව් කරනවා
        cursor.execute("""
            INSERT INTO target_locations (name, contact, latitude, longitude, category)
            VALUES (%s, %s, %s, %s, %s)
        """, (req.name, req.contact, req.latitude, req.longitude, req.category))
        
        # අලුතින් සේව් වුණ කඩේ ID එක ගන්නවා
        new_location_id = cursor.lastrowid
        
        # 2. ඊටපස්සේ රෙප්ගේ රිපෝට් එක (met_person එක්කම) rep_assignments එකට දානවා
        # (is_unassigned = 1 කියලා දාන්නේ Admin ට අලුත් ඒවා වෙන් කරලා අඳුරගන්න ලේසි වෙන්නයි)
        cursor.execute("""
            INSERT INTO rep_assignments (rep_id, location_id, assigned_date, status, met_person, visit_notes, is_unassigned)
            VALUES (%s, %s, CURDATE(), 'Visited', %s, %s, 1)
        """, (req.rep_id, new_location_id, req.met_person, req.visit_notes))
        
        conn.commit()
        return {"message": "New location and visit added successfully!"}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()