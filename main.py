from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import mysql.connector
import smtplib
from email.message import EmailMessage
import random
import bcrypt

app = FastAPI()

SENDER_EMAIL = "familydoctorhealth@gmail.com"
APP_PASSWORD = "lkqm npoz qtqd sqf"
otp_storage = {}


def get_db_connection():
    return mysql.connector.connect(
        host="localhost",
        user="rep_user",
        password="RepAdmin@123",
        database="rep_management_db",
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
    status: str  # Positive/Negative
    met_person: str
    contact_number: str
    visit_notes: str


class UnplannedVisit(BaseModel):
    rep_id: int
    name: str
    contact: str
    category: str
    latitude: float
    longitude: float
    met_person: str
    person_contact: str
    status: str
    visit_notes: str


def send_email(to_email: str, otp: str):
    msg = EmailMessage()
    msg.set_content(f"Your OTP is: {otp}")
    msg["Subject"] = "Rep Route Pro - Verification OTP"
    msg["From"] = SENDER_EMAIL
    msg["To"] = to_email
    try:
        server = smtplib.SMTP_SSL("smtp.gmail.com", 465)
        server.login(SENDER_EMAIL, APP_PASSWORD)
        server.send_message(msg)
        server.quit()
        return True
    except:
        return False


@app.post("/send-otp")
def send_otp(req: OTPRequest):
    otp = str(random.randint(100000, 999999))
    print(f"🚨 DEBUG: OTP FOR {req.email} IS: {otp} 🚨")
    is_sent = send_email(req.email, otp)
    otp_storage[req.email] = otp
    return {"message": "OTP processed."}


@app.post("/register")
def register(req: RegisterRequest):
    if otp_storage.get(req.email) != req.otp:
        raise HTTPException(status_code=400, detail="Invalid OTP!")
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM users WHERE username = %s OR email = %s",
        (req.username, req.email),
    )
    if cursor.fetchone():
        raise HTTPException(status_code=400, detail="User exists!")
    hashed_pw = bcrypt.hashpw(req.password.encode("utf-8"), bcrypt.gensalt())
    cursor.execute(
        "INSERT INTO users (first_name, last_name, email, username, password, mobile_number, whatsapp_number) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (
            req.first_name,
            req.last_name,
            req.email,
            req.username,
            hashed_pw.decode("utf-8"),
            req.mobile_number,
            req.whatsapp_number,
        ),
    )
    conn.commit()
    conn.close()
    return {"message": "Registered successfully!"}


@app.post("/login")
def login(req: LoginRequest):
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT * FROM users WHERE username = %s", (req.username,))
    user = cursor.fetchone()
    conn.close()
    if not user or not bcrypt.checkpw(
        req.password.encode("utf-8"), user["password"].encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return {
        "message": "Login successful!",
        "user": {
            "id": user["id"],
            "first_name": user["first_name"],
            "last_name": user["last_name"],
            "username": user["username"],
        },
    }


@app.post("/update-location")
def update_location(req: LocationUpdate):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO rep_tracking (rep_id, latitude, longitude) VALUES (%s, %s, %s)",
        (req.rep_id, req.latitude, req.longitude),
    )
    conn.commit()
    conn.close()
    return {"message": "Location updated"}


# --- 🚀 අලුත්/අප්ඩේට් කරපු API ටික ---
@app.get("/tasks/{rep_id}")
def get_daily_tasks(rep_id: int):
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        query = """
            SELECT ra.id as assignment_id, ra.status as assignment_status, tl.id as location_id, 
                   tl.name as store_name, tl.contact, tl.latitude, tl.longitude
            FROM rep_assignments ra JOIN target_locations tl ON ra.location_id = tl.id 
            WHERE ra.rep_id = %s AND ra.assigned_date = CURDATE()
        """
        cursor.execute(query, (rep_id,))
        tasks = cursor.fetchall()

        # එක් එක් කඩේට අදාළව හම්බවුණු 'ඔක්කොම මිනිස්සු' (Logs) ලිස්ට් එක ගන්නවා
        for task in tasks:
            cursor.execute(
                "SELECT met_person, contact_number, status, notes, created_at FROM visit_logs WHERE assignment_id = %s ORDER BY created_at DESC",
                (task["assignment_id"],),
            )
            task["logs"] = cursor.fetchall()
        return {"tasks": tasks}
    finally:
        conn.close()


@app.post("/update-task")
def update_task(req: TaskUpdate):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "UPDATE rep_assignments SET status = 'Visited' WHERE id = %s",
            (req.assignment_id,),
        )
        cursor.execute(
            "INSERT INTO visit_logs (assignment_id, met_person, contact_number, status, notes) VALUES (%s, %s, %s, %s, %s)",
            (
                req.assignment_id,
                req.met_person,
                req.contact_number,
                req.status,
                req.visit_notes,
            ),
        )
        conn.commit()
        return {"message": "Task updated"}
    finally:
        conn.close()


@app.post("/add-unplanned-visit")
def add_unplanned_visit(req: UnplannedVisit):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO target_locations (name, contact, latitude, longitude, category) VALUES (%s, %s, %s, %s, %s)",
            (req.name, req.contact, req.latitude, req.longitude, req.category),
        )
        new_loc_id = cursor.lastrowid

        cursor.execute(
            "INSERT INTO rep_assignments (rep_id, location_id, assigned_date, status, is_unassigned) VALUES (%s, %s, CURDATE(), 'Visited', 1)",
            (req.rep_id, new_loc_id),
        )
        new_assign_id = cursor.lastrowid

        cursor.execute(
            "INSERT INTO visit_logs (assignment_id, met_person, contact_number, status, notes) VALUES (%s, %s, %s, %s, %s)",
            (
                new_assign_id,
                req.met_person,
                req.person_contact,
                req.status,
                req.visit_notes,
            ),
        )
        conn.commit()
        return {"message": "Visit added!"}
    finally:
        conn.close()
