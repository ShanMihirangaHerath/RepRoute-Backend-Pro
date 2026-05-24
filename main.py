from fastapi import FastAPI, HTTPException, BackgroundTasks
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

# අලුත් Location Update Model එක
class LocationUpdate(BaseModel):
    rep_id: int
    latitude: float
    longitude: float

# Email sending function
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
    except Exception as e:
        print(f"Failed to send email: {e}")

@app.get("/")
def read_root():
    return {"message": "Rep Route API is Running Successfully!"}

# 1. OTP Sender Endpoint
@app.post("/send-otp")
def send_otp(req: OTPRequest, background_tasks: BackgroundTasks):
    otp = str(random.randint(100000, 999999))
    otp_storage[req.email] = otp
    background_tasks.add_task(send_email, req.email, otp) # email sending in background
    return {"message": "OTP sent to email successfully!"}

# 2. Register Endpoint
@app.post("/register")
def register(req: RegisterRequest):
    if otp_storage.get(req.email) != req.otp:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP!")

    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT * FROM users WHERE username = %s", (req.username,))
    if cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=400, detail="Username already exists! Please try another.")

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

# 3. Login Endpoint
@app.post("/login")
def login(req: LoginRequest):
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT * FROM users WHERE username = %s", (req.username,))
    user = cursor.fetchone()
    conn.close()

    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password")

    if not bcrypt.checkpw(req.password.encode('utf-8'), user['password'].encode('utf-8')):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    return {
        "message": "Login successful!", 
        "user": {
            "id": user["id"],  # <--- ID එක අලුතින් යවනවා
            "first_name": user["first_name"], 
            "last_name": user["last_name"], 
            "username": user["username"]
        }
    }

# 4. Location Update Endpoint (අලුත් API එක)
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