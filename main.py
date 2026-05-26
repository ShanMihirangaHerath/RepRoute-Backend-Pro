from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
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
    return mysql.connector.connect(host="localhost", user="rep_user", password="RepAdmin@123", database="rep_management_db")

class OTPRequest(BaseModel): email: str
class RegisterRequest(BaseModel): first_name: str; last_name: str; email: str; username: str; password: str; mobile_number: str; whatsapp_number: str; otp: str
class LoginRequest(BaseModel): username: str; password: str
class LocationUpdate(BaseModel): rep_id: int; latitude: float; longitude: float

class TaskUpdate(BaseModel):
    assignment_id: int
    status: str 
    met_person: str
    contact_number: str
    visit_notes: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class UnplannedVisit(BaseModel):
    rep_id: int; name: str; contact: str; category: str; latitude: float; longitude: float; met_person: str; person_contact: str; status: str; visit_notes: str

class BankUpdate(BaseModel): rep_id: int; bank_account: str
class SalaryReq(BaseModel): rep_id: int; amount: float
class ReportSubmit(BaseModel): rep_id: int
class ActivitySync(BaseModel): rep_id: int; steps: int; distance_km: float; calories: float
class LeaveRequest(BaseModel): rep_id: int; leave_date: str; reason: str
class ExpenseClaim(BaseModel): rep_id: int; expense_date: str; amount: float; description: str

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
    except: return False

@app.post("/send-otp")
def send_otp(req: OTPRequest):
    otp = str(random.randint(100000, 999999))
    print(f"🚨 DEBUG: OTP FOR {req.email} IS: {otp} 🚨")
    is_sent = send_email(req.email, otp)
    otp_storage[req.email] = otp
    return {"message": "OTP processed."}

@app.post("/register")
def register(req: RegisterRequest):
    if otp_storage.get(req.email) != req.otp: raise HTTPException(status_code=400, detail="Invalid OTP!")
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE username = %s OR email = %s", (req.username, req.email))
    if cursor.fetchone(): raise HTTPException(status_code=400, detail="User exists!")
    hashed_pw = bcrypt.hashpw(req.password.encode("utf-8"), bcrypt.gensalt())
    cursor.execute("INSERT INTO users (first_name, last_name, email, username, password, mobile_number, whatsapp_number) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                   (req.first_name, req.last_name, req.email, req.username, hashed_pw.decode("utf-8"), req.mobile_number, req.whatsapp_number))
    conn.commit(); conn.close()
    return {"message": "Registered successfully!"}

@app.post("/login")
def login(req: LoginRequest):
    conn = get_db_connection(); cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT * FROM users WHERE username = %s", (req.username,))
    user = cursor.fetchone(); conn.close()
    if not user or not bcrypt.checkpw(req.password.encode("utf-8"), user["password"].encode("utf-8")): raise HTTPException(status_code=401, detail="Invalid credentials")
    return {"message": "Login successful!", "user": {"id": user["id"], "first_name": user["first_name"], "last_name": user["last_name"], "username": user["username"]}}

@app.post("/update-location")
def update_location(req: LocationUpdate):
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("INSERT INTO rep_tracking (rep_id, latitude, longitude) VALUES (%s, %s, %s)", (req.rep_id, req.latitude, req.longitude))
    conn.commit(); conn.close()
    return {"message": "Location updated"}

@app.get("/tasks/{rep_id}")
def get_daily_tasks(rep_id: int):
    conn = get_db_connection(); cursor = conn.cursor(dictionary=True)
    try:
        query = """
            SELECT ra.id as assignment_id, ra.status as assignment_status, ra.assigned_date, ra.is_unassigned,
                   tl.id as location_id, tl.name as store_name, tl.contact, tl.latitude, tl.longitude
            FROM rep_assignments ra 
            JOIN target_locations tl ON ra.location_id = tl.id 
            WHERE ra.rep_id = %s ORDER BY ra.assigned_date DESC
        """
        cursor.execute(query, (rep_id,))
        tasks = cursor.fetchall()
        for task in tasks:
            task['assigned_date'] = str(task['assigned_date']) 
            cursor.execute("SELECT met_person, contact_number, status, notes, created_at FROM visit_logs WHERE assignment_id = %s ORDER BY created_at DESC", (task['assignment_id'],))
            logs = cursor.fetchall()
            for log in logs: log['created_at'] = str(log['created_at'])
            task['logs'] = logs
        return {"tasks": tasks}
    finally: conn.close()

@app.post("/update-task")
def update_task(req: TaskUpdate):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("UPDATE rep_assignments SET status = 'Visited' WHERE id = %s", (req.assignment_id,))
        cursor.execute(
            "INSERT INTO visit_logs (assignment_id, met_person, contact_number, status, notes, latitude, longitude) VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (req.assignment_id, req.met_person, req.contact_number, req.status, req.visit_notes, req.latitude, req.longitude)
        )
        conn.commit()
        return {"message": "Task updated"}
    finally:
        conn.close()


@app.post("/add-unplanned-visit")
def add_unplanned_visit(req: UnplannedVisit):
    conn = get_db_connection(); cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO target_locations (name, contact, latitude, longitude, category) VALUES (%s, %s, %s, %s, %s)",
                       (req.name, req.contact, req.latitude, req.longitude, req.category))
        new_loc_id = cursor.lastrowid
        cursor.execute("INSERT INTO rep_assignments (rep_id, location_id, assigned_date, status, is_unassigned) VALUES (%s, %s, CURDATE(), 'Visited', 1)",
                       (req.rep_id, new_loc_id))
        new_assign_id = cursor.lastrowid
        cursor.execute("INSERT INTO visit_logs (assignment_id, met_person, contact_number, status, notes) VALUES (%s, %s, %s, %s, %s)",
                       (new_assign_id, req.met_person, req.person_contact, req.status, req.visit_notes))
        conn.commit()
        return {"message": "Visit added!"}
    finally: conn.close()

# 🚀 1. Profile Data API (DUPLICATE එක අයින් කරලා හරියටම හැදුවා)
@app.get("/profile-data/{rep_id}")
def get_profile_data(rep_id: int):
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT first_name, last_name, email, mobile_number, bank_account FROM users WHERE id = %s", (rep_id,))
        user = cursor.fetchone()

        cursor.execute("""
            SELECT COUNT(id) as total_assigned,
                   COALESCE(SUM(CASE WHEN status = 'Visited' THEN 1 ELSE 0 END), 0) as completed,
                   COALESCE(SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END), 0) as pending
            FROM rep_assignments WHERE rep_id = %s
        """, (rep_id,))
        stats = cursor.fetchone()

        cursor.execute("""
            SELECT tl.name as store_name, vl.met_person, vl.contact_number, vl.status, vl.notes, vl.created_at
            FROM visit_logs vl JOIN rep_assignments ra ON vl.assignment_id = ra.id
            JOIN target_locations tl ON ra.location_id = tl.id
            WHERE ra.rep_id = %s AND ra.assigned_date = CURDATE() ORDER BY vl.created_at DESC
        """, (rep_id,))
        logs = cursor.fetchall()
        
        positive_count = sum(1 for log in logs if log['status'] == 'Positive')
        revisit_count = sum(1 for log in logs if log['status'] == 'Needs Revisit')
        not_found_count = sum(1 for log in logs if log['status'] == 'Shop Not Found') # 🚀 අලුත්

        cursor.execute("SELECT id FROM daily_reports WHERE rep_id = %s AND report_date = CURDATE()", (rep_id,))
        is_report_sent = cursor.fetchone() is not None

        cursor.execute("SELECT amount, status, requested_at, paid_at FROM salary_requests WHERE rep_id = %s ORDER BY requested_at DESC", (rep_id,))
        salary_history = cursor.fetchall()
        for s in salary_history:
            s['requested_at'] = str(s['requested_at'])
            s['paid_at'] = str(s['paid_at']) if s['paid_at'] else None

        cursor.execute("SELECT sender, message, created_at FROM messages WHERE rep_id = %s ORDER BY created_at DESC LIMIT 5", (rep_id,))
        messages = cursor.fetchall()
        for log in logs: log['created_at'] = str(log['created_at'])

        return {
            "user": user,
            "stats": {"total_assigned": stats['total_assigned'] or 0, "completed": stats['completed'] or 0, "pending": stats['pending'] or 0, "positive": positive_count, "revisit": revisit_count, "not_found": not_found_count},
            "visited_details": logs, "is_report_sent": is_report_sent, "salary_history": salary_history, "messages": messages
        }
    finally: conn.close()


@app.post("/update-bank")
def update_bank(req: BankUpdate):
    conn = get_db_connection(); cursor = conn.cursor()
    try:
        cursor.execute("UPDATE users SET bank_account = %s WHERE id = %s", (req.bank_account, req.rep_id))
        conn.commit()
        return {"message": "Bank account updated!"}
    finally: conn.close()

@app.post("/request-salary")
def request_salary(req: SalaryReq):
    conn = get_db_connection(); cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO salary_requests (rep_id, amount, status) VALUES (%s, %s, 'Pending')", (req.rep_id, req.amount))
        conn.commit()
        return {"message": "Salary requested successfully!"}
    finally: conn.close()

@app.post("/submit-report")
def submit_report(req: ReportSubmit):
    conn = get_db_connection(); cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT COUNT(*) as visited_count FROM rep_assignments WHERE rep_id = %s AND assigned_date = CURDATE() AND status = 'Visited'", (req.rep_id,))
        visited_count = cursor.fetchone()['visited_count']
        if visited_count == 0: raise HTTPException(status_code=400, detail="No visited tasks to submit today.")
        cursor.execute("INSERT INTO daily_reports (rep_id, report_date, total_visited) VALUES (%s, CURDATE(), %s)", (req.rep_id, visited_count))
        conn.commit()
        return {"message": "Report submitted to Admin!"}
    finally: conn.close()

@app.post("/sync-activity")
def sync_activity(req: ActivitySync):
    conn = get_db_connection(); cursor = conn.cursor()
    try:
        cursor.execute("""
            INSERT INTO activity_history (rep_id, record_date, steps, distance_km, calories) VALUES (%s, CURDATE(), %s, %s, %s)
            ON DUPLICATE KEY UPDATE steps = %s, distance_km = %s, calories = %s
        """, (req.rep_id, req.steps, req.distance_km, req.calories, req.steps, req.distance_km, req.calories))
        conn.commit()
        return {"message": "Activity synced"}
    finally: conn.close()

@app.get("/activity-history/{rep_id}")
def get_activity_history(rep_id: int, date: str):
    conn = get_db_connection(); cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT steps, distance_km, calories FROM activity_history WHERE rep_id = %s AND record_date = %s", (rep_id, date))
        data = cursor.fetchone()
        return data if data else {"steps": 0, "distance_km": 0.0, "calories": 0.0}
    finally: conn.close()

@app.post("/request-leave")
def request_leave(req: LeaveRequest):
    conn = get_db_connection(); cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO leave_requests (rep_id, leave_date, reason, status) VALUES (%s, %s, %s, 'Pending')", (req.rep_id, req.leave_date, req.reason))
        conn.commit()
        return {"message": "Leave request submitted successfully!"}
    finally: conn.close()

@app.get("/my-leaves/{rep_id}")
def get_my_leaves(rep_id: int):
    conn = get_db_connection(); cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id, leave_date, reason, status, created_at FROM leave_requests WHERE rep_id = %s ORDER BY created_at DESC", (rep_id,))
        leaves = cursor.fetchall()
        for leave in leaves: leave['leave_date'] = str(leave['leave_date']); leave['created_at'] = str(leave['created_at'])
        return leaves
    finally: conn.close()

@app.post("/submit-expense")
def submit_expense(req: ExpenseClaim):
    conn = get_db_connection(); cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO expenses (rep_id, expense_date, amount, description, status) VALUES (%s, %s, %s, %s, 'Pending')", (req.rep_id, req.expense_date, req.amount, req.description))
        conn.commit()
        return {"message": "Expense claim submitted successfully!"}
    finally: conn.close()

@app.get("/my-expenses/{rep_id}")
def get_my_expenses(rep_id: int):
    conn = get_db_connection(); cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id, expense_date, amount, description, status, created_at FROM expenses WHERE rep_id = %s ORDER BY created_at DESC", (rep_id,))
        expenses = cursor.fetchall()
        for exp in expenses: exp['expense_date'] = str(exp['expense_date']); exp['created_at'] = str(exp['created_at'])
        return expenses
    finally: conn.close()