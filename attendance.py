import sqlite3
import os
import json
import secrets
import hashlib
import hmac
from datetime import datetime

try:
    import bcrypt
except ImportError:
    bcrypt = None

from email_service import send_arrival_email

DATABASE = os.path.join(
    os.path.dirname(
        os.path.abspath(__file__)
    ),
    "attendance.db"
)


# ============================================================
# DATABASE
# ============================================================

def get_connection():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    return connection


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100000)
    return f"pbkdf2_sha256$100000${salt}${key.hex()}"


def verify_password(plain_password: str, hashed_password: str) -> bool:
    if not hashed_password or not plain_password:
        return False
    try:
        if hashed_password.startswith("pbkdf2_sha256$"):
            parts = hashed_password.split("$")
            iterations = int(parts[1])
            salt = parts[2].encode("utf-8")
            expected_key = parts[3]
            key = hashlib.pbkdf2_hmac("sha256", plain_password.encode("utf-8"), salt, iterations)
            return hmac.compare_digest(key.hex(), expected_key)
        if bcrypt and (hashed_password.startswith("$2a$") or hashed_password.startswith("$2b$")):
            return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))
        return False
    except Exception:
        return False


def create_database():
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS employees (
            employee_id TEXT PRIMARY KEY,
            employee_name TEXT NOT NULL,
            shift_start TEXT NOT NULL,
            shift_end TEXT DEFAULT '22:00',
            email TEXT,
            login_id TEXT,
            hubble_id TEXT,
            reports_to TEXT,
            reports_to_mail_id TEXT,
            hr_contact TEXT,
            hr_email TEXT,
            department TEXT,
            designation TEXT,
            team_name TEXT,
            work_location TEXT DEFAULT 'Miracle City (HQ)',
            is_flexible_shift INTEGER DEFAULT 0
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS attendance_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id TEXT NOT NULL,
            event_date TEXT NOT NULL,
            event_time TEXT NOT NULL,
            event_type TEXT NOT NULL
                CHECK(event_type IN ('IN', 'OUT')),
            created_at TEXT NOT NULL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS daily_attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id TEXT NOT NULL,
            attendance_date TEXT NOT NULL,
            first_in TEXT,
            last_out TEXT,
            arrival_status TEXT,
            early_minutes INTEGER DEFAULT 0,
            late_minutes INTEGER DEFAULT 0,
            worked_minutes INTEGER DEFAULT 0,
            status TEXT,
            break_minutes INTEGER DEFAULT 0,
            email_sent INTEGER DEFAULT 0,
            UNIQUE(employee_id, attendance_date)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS leave_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id TEXT NOT NULL,
            leave_date TEXT NOT NULL,
            leave_type TEXT NOT NULL DEFAULT 'Leave',
            reason TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(employee_id, leave_date)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('superior', 'admin', 'hr')),
            department TEXT,
            display_name TEXT,
            must_change_password INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            created_by TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_username TEXT NOT NULL,
            actor_role TEXT NOT NULL,
            action_type TEXT NOT NULL,
            target_id TEXT,
            target_date TEXT,
            before_value TEXT,
            after_value TEXT,
            reason TEXT,
            timestamp TEXT NOT NULL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS departments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS user_sessions (
            token TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            role TEXT NOT NULL,
            department TEXT,
            created_at TEXT NOT NULL
        )
    """)

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_events_employee_date
        ON attendance_events(employee_id, event_date)
    """)

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_events_date
        ON attendance_events(event_date)
    """)

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_leave_employee_date
        ON leave_records(employee_id, leave_date)
    """)

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
        ON audit_logs(actor_username, actor_role)
    """)

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_users_username
        ON users(username)
    """)

    connection.commit()

    cursor.execute("PRAGMA table_info(employees)")
    employee_columns = [
        column["name"]
        for column in cursor.fetchall()
    ]

    if "shift_end" not in employee_columns:
        cursor.execute("""
            ALTER TABLE employees
            ADD COLUMN shift_end TEXT DEFAULT '22:00'
        """)

    hubble_columns = {
        "login_id": "TEXT",
        "hubble_id": "TEXT",
        "reports_to": "TEXT",
        "reports_to_mail_id": "TEXT",
        "hr_contact": "TEXT",
        "hr_email": "TEXT",
        "department": "TEXT",
        "designation": "TEXT",
        "team_name": "TEXT",
        "work_location": "TEXT DEFAULT 'Miracle City (HQ)'",
        "is_flexible_shift": "INTEGER DEFAULT 0",
    }

    for column_name, column_type in hubble_columns.items():
        if column_name not in employee_columns:
            cursor.execute(
                f"ALTER TABLE employees ADD COLUMN {column_name} {column_type}"
            )
            employee_columns.append(column_name)

    cursor.execute("PRAGMA table_info(daily_attendance)")
    daily_columns = [col["name"] for col in cursor.fetchall()]
    if "status" not in daily_columns:
        cursor.execute("ALTER TABLE daily_attendance ADD COLUMN status TEXT")
    if "break_minutes" not in daily_columns:
        cursor.execute("ALTER TABLE daily_attendance ADD COLUMN break_minutes INTEGER DEFAULT 0")

    # Seed departments
    initial_departments = [
        "Innovation",
        "Software Training",
        "MAPPS",
        "DAAPS",
        "Software Services",
        "Human Resources",
        "Quality Assurance",
        "Operations",
        "Delivery",
    ]
    for dept_name in initial_departments:
        cursor.execute("INSERT OR IGNORE INTO departments (name) VALUES (?)", (dept_name,))

    cursor.execute("SELECT DISTINCT department FROM employees WHERE department IS NOT NULL AND department != ''")
    for row in cursor.fetchall():
        cursor.execute("INSERT OR IGNORE INTO departments (name) VALUES (?)", (row[0],))

    # Seed default users if empty
    cursor.execute("SELECT COUNT(*) FROM users")
    if cursor.fetchone()[0] == 0:
        now_str = datetime.now().isoformat()
        sup_pass = os.getenv("SUPERIOR_PASSWORD", "superior123")
        sup_hash = hash_password(sup_pass)
        cursor.execute("""
            INSERT INTO users (username, password_hash, role, department, display_name, must_change_password, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, ("superior", sup_hash, "superior", "ALL", "Executive Superior", 0, now_str, "SYSTEM"))

        adm_pass = os.getenv("ADMIN_PASSWORD", "admin123")
        adm_hash = hash_password(adm_pass)
        cursor.execute("""
            INSERT INTO users (username, password_hash, role, department, display_name, must_change_password, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, ("admin", adm_hash, "admin", "ALL", "System Administrator", 0, now_str, "SYSTEM"))

        hr_pass = os.getenv("HR_PASSWORD", "hr123")
        hr_hash = hash_password(hr_pass)
        default_hrs = [
            ("hr", "Software Services", "HR Manager (Software Services)"),
            ("purnima", "Human Resources", "HR Manager (Human Resources)"),
            ("hr_innovation", "Innovation", "HR Manager (Innovation)"),
            ("hr_daapps", "Daapps", "HR Manager (DAAPS)"),
            ("hr_mapps", "MAPPS", "HR Manager (MAPPS)"),
            ("hr_training", "Software Training", "HR Manager (Software Training)"),
        ]
        for u, d, dn in default_hrs:
            cursor.execute("""
                INSERT OR IGNORE INTO users (username, password_hash, role, department, display_name, must_change_password, created_at, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (u, hr_hash, "hr", d, dn, 0, now_str, "SYSTEM"))

    # Ensure default user hashes are valid if they were seeded with older dummy strings
    default_logins = [
        ("superior", "superior123"),
        ("admin", "admin123"),
        ("hr", "hr123"),
        ("purnima", "hr123"),
        ("hr_innovation", "hr123"),
        ("hr_daapps", "hr123"),
        ("hr_mapps", "hr123"),
        ("hr_training", "hr123"),
    ]
    for usr, pwd in default_logins:
        cursor.execute("SELECT password_hash FROM users WHERE username = ?", (usr,))
        row = cursor.fetchone()
        if row and not verify_password(pwd, row[0]):
            cursor.execute("UPDATE users SET password_hash = ? WHERE username = ?", (hash_password(pwd), usr))

    connection.commit()
    connection.close()


# ============================================================
# USER & AUDIT MANAGEMENT
# ============================================================

def map_designation_to_role(designation: str) -> str | None:
    if not designation:
        return None
    d = str(designation).strip().lower()
    if any(k in d for k in ("superior", "director", "vice president", "vp", "chief", "executive", "ceo", "coo", "cto")):
        return "superior"
    if any(k in d for k in ("administrator", "admin", "system admin", "sysadmin")):
        return "admin"
    if any(k in d for k in ("hr", "human resource", "talent", "people ops", "recruiter")):
        return "hr"
    return None


def get_user_by_username(username: str):
    if not username:
        return None
    connection = get_connection()
    cursor = connection.cursor()
    cursor.execute("""
        SELECT id, username, password_hash, role, department, display_name, must_change_password, created_at, created_by
        FROM users WHERE LOWER(username) = LOWER(?)
    """, (username.strip(),))
    row = cursor.fetchone()
    if not row:
        # Check if username matches an employee login_id or employee_id linked to a user
        cursor.execute("""
            SELECT u.id, u.username, u.password_hash, u.role, u.department, u.display_name, u.must_change_password, u.created_at, u.created_by
            FROM employees e
            JOIN users u ON LOWER(u.username) = LOWER(e.login_id) OR LOWER(u.username) = LOWER(e.employee_id)
            WHERE LOWER(e.login_id) = LOWER(?) OR LOWER(e.employee_id) = LOWER(?)
        """, (username.strip(), username.strip()))
        row = cursor.fetchone()
    connection.close()
    if not row:
        return None
    user_dict = dict(row)
    if not user_dict.get("role"):
        mapped = map_designation_to_role(user_dict.get("display_name") or "")
        user_dict["role"] = mapped or "hr"
    return user_dict



def create_user(username: str, password: str, role: str, department: str = None, display_name: str = None, must_change_password: int = 0, created_by: str = None):
    username = username.strip()
    role = role.strip().lower()
    if role not in ("superior", "admin", "hr"):
        raise ValueError("Invalid role. Must be superior, admin, or hr.")
    if not username:
        raise ValueError("Username cannot be empty.")
    if not password or len(password) < 4:
        raise ValueError("Password must be at least 4 characters long.")

    connection = get_connection()
    cursor = connection.cursor()
    cursor.execute("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", (username,))
    if cursor.fetchone():
        connection.close()
        raise ValueError(f"User '{username}' already exists.")

    password_hash = hash_password(password)
    now_str = datetime.now().isoformat()
    cursor.execute("""
        INSERT INTO users (username, password_hash, role, department, display_name, must_change_password, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        username,
        password_hash,
        role,
        department.strip() if department else ("ALL" if role != "hr" else None),
        display_name.strip() if display_name else username,
        1 if must_change_password else 0,
        now_str,
        created_by,
    ))
    user_id = cursor.lastrowid
    connection.commit()
    connection.close()

    create_audit_log(
        actor_username=created_by or "SYSTEM",
        actor_role="superior" if role == "admin" else ("admin" if role == "hr" else "system"),
        action_type=f"CREATE_{role.upper()}",
        target_id=username,
        reason=f"Account created for role {role} (department: {department or 'ALL'})",
    )
    return get_user_by_username(username)


def update_user_password(username: str, new_password: str, actor_username: str = None):
    if not new_password or len(new_password) < 4:
        raise ValueError("New password must be at least 4 characters long.")
    connection = get_connection()
    cursor = connection.cursor()
    cursor.execute("SELECT id, username, role FROM users WHERE LOWER(username) = LOWER(?)", (username.strip(),))
    user = cursor.fetchone()
    if not user:
        connection.close()
        raise ValueError(f"User '{username}' not found.")

    new_hash = hash_password(new_password)
    cursor.execute("""
        UPDATE users
        SET password_hash = ?, must_change_password = 0
        WHERE id = ?
    """, (new_hash, user["id"]))
    connection.commit()
    connection.close()

    create_audit_log(
        actor_username=actor_username or username,
        actor_role=user["role"],
        action_type="PASSWORD_CHANGE",
        target_id=username,
        reason="Password updated successfully",
    )
    return True


def list_users(role: str = None, department: str = None):
    connection = get_connection()
    cursor = connection.cursor()
    query = """
        SELECT id, username, role, department, display_name, must_change_password, created_at, created_by
        FROM users WHERE 1=1
    """
    params = []
    if role:
        query += " AND LOWER(role) = LOWER(?)"
        params.append(role.strip())
    if department and department.upper() != "ALL":
        query += " AND LOWER(department) = LOWER(?)"
        params.append(department.strip())
    query += " ORDER BY id ASC"
    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    connection.close()
    return [dict(row) for row in rows]


def create_audit_log(
    actor_username: str,
    actor_role: str,
    action_type: str,
    target_id: str = None,
    target_date: str = None,
    before_value: str = None,
    after_value: str = None,
    reason: str = None,
    target_employee_id: str = None,
    details: str = None,
):
    connection = get_connection()
    cursor = connection.cursor()
    final_target = target_id or target_employee_id or ""
    final_reason = reason or details or ""
    cursor.execute("""
        INSERT INTO audit_logs (actor_username, actor_role, action_type, target_id, target_date, before_value, after_value, reason, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        actor_username,
        actor_role,
        action_type,
        final_target,
        target_date,
        before_value,
        after_value,
        final_reason,
        datetime.now().isoformat(),
    ))
    connection.commit()
    connection.close()


def get_audit_logs(limit: int = 200, actor_role: str = None, action_type: str = None, target_date: str = None):
    connection = get_connection()
    cursor = connection.cursor()
    query = "SELECT id, actor_username, actor_role, action_type, target_id, target_date, before_value, after_value, reason, timestamp FROM audit_logs WHERE 1=1"
    params = []
    if actor_role:
        query += " AND LOWER(actor_role) = LOWER(?)"
        params.append(actor_role.strip())
    if action_type:
        query += " AND LOWER(action_type) = LOWER(?)"
        params.append(action_type.strip())
    if target_date:
        query += " AND target_date = ?"
        params.append(target_date.strip())
    query += f" ORDER BY id DESC LIMIT {int(limit)}"
    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    connection.close()
    return [dict(row) for row in rows]


def create_session(username: str, role: str, department: str = None) -> str:
    token = secrets.token_hex(32)
    connection = get_connection()
    cursor = connection.cursor()
    cursor.execute("""
        INSERT INTO user_sessions (token, username, role, department, created_at)
        VALUES (?, ?, ?, ?, ?)
    """, (token, username, role, department, datetime.now().isoformat()))
    connection.commit()
    connection.close()
    return token


def get_session(token: str):
    if not token:
        return None
    connection = get_connection()
    cursor = connection.cursor()
    cursor.execute("""
        SELECT token, username, role, department, created_at
        FROM user_sessions WHERE token = ?
    """, (token,))
    row = cursor.fetchone()
    connection.close()
    return dict(row) if row else None


def delete_session(token: str):
    if not token:
        return
    connection = get_connection()
    cursor = connection.cursor()
    cursor.execute("DELETE FROM user_sessions WHERE token = ?", (token,))
    connection.commit()
    connection.close()


def get_departments_list():
    connection = get_connection()
    cursor = connection.cursor()
    cursor.execute("""
        SELECT name FROM departments
        UNION
        SELECT DISTINCT department as name FROM employees WHERE department IS NOT NULL AND department != ''
        ORDER BY name COLLATE NOCASE ASC
    """)
    rows = cursor.fetchall()
    connection.close()
    return [row["name"] for row in rows if row["name"]]


# ============================================================
# EMPLOYEE MANAGEMENT
# ============================================================

def is_flexible_shift_employee(employee_or_designation, is_flexible_shift=None):
    if employee_or_designation is None:
        return bool(is_flexible_shift)
    if isinstance(employee_or_designation, (dict, sqlite3.Row)):
        employee = employee_or_designation
        try:
            if bool(employee["is_flexible_shift"]):
                return True
        except Exception:
            pass
        designation = str(employee["designation"] if "designation" in employee.keys() else "").lower()
        shift_start = str(employee["shift_start"] if "shift_start" in employee.keys() else "").lower()
        shift_end = str(employee["shift_end"] if "shift_end" in employee.keys() else "").lower()
        if shift_start == "flexible" or shift_end == "flexible":
            return True
    else:
        designation = str(employee_or_designation or "").lower()
        if bool(is_flexible_shift):
            return True

    director_keywords = ["director", "managing director", "associate director", "executive director", "vp", "vice president", "chief", "president", "head of", "cxo"]
    for keyword in director_keywords:
        if keyword in designation:
            return True
    return False


def calculate_attendance_status(worked_minutes, is_leave=False, is_weekend=False):
    if is_weekend:
        return "WEEKEND"
    if is_leave:
        return "LEAVE"
    worked_minutes = int(worked_minutes or 0)
    if worked_minutes < 240:
        return "ABSENT"
    elif worked_minutes <= 450:
        return "HALF_DAY"
    else:
        return "FULL_DAY"


def calculate_break_minutes(sessions, shift_start, shift_end, worked_minutes, is_flexible=False):
    if not sessions or worked_minutes <= 0:
        return 0
    if is_flexible:
        break_mins = 0
        sorted_sessions = sorted(sessions, key=lambda s: s.get("check_in") or "")
        for i in range(len(sorted_sessions) - 1):
            s1_out = sorted_sessions[i].get("check_out")
            s2_in = sorted_sessions[i + 1].get("check_in")
            if s1_out and s2_in:
                gap = calculate_time_difference(s1_out, s2_in)
                break_mins += gap
        return max(0, break_mins)
    else:
        sched_mins = _scheduled_shift_minutes(shift_start, shift_end)
        if sched_mins <= 0:
            sched_mins = 480
        return max(0, sched_mins - worked_minutes)


def add_employee(
    employee_id,
    employee_name,
    shift_start,
    email,
    shift_end="22:00",
    login_id=None,
    hubble_id=None,
    reports_to=None,
    reports_to_mail_id=None,
    hr_contact=None,
    hr_email=None,
    department=None,
    designation=None,
    team_name=None,
    work_location="Miracle City (HQ)",
    is_flexible_shift=0,
):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        INSERT OR REPLACE INTO employees
        (
            employee_id,
            employee_name,
            shift_start,
            shift_end,
            email,
            login_id,
            hubble_id,
            reports_to,
            reports_to_mail_id,
            hr_contact,
            hr_email,
            department,
            designation,
            team_name,
            work_location,
            is_flexible_shift
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        employee_id,
        employee_name,
        shift_start,
        shift_end,
        email,
        login_id,
        hubble_id,
        reports_to,
        reports_to_mail_id,
        hr_contact,
        hr_email,
        department,
        designation,
        team_name,
        work_location or "Miracle City (HQ)",
        1 if is_flexible_shift else 0,
    ))

    connection.commit()
    connection.close()

    print(
        f"Employee {employee_id} added successfully."
    )


def get_employee(employee_id):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            employee_id,
            employee_name,
            shift_start,
            shift_end,
            email,
            login_id,
            hubble_id,
            reports_to,
            reports_to_mail_id,
            hr_contact,
            hr_email,
            department,
            designation,
            team_name,
            work_location,
            is_flexible_shift
        FROM employees
        WHERE employee_id = ?
    """, (employee_id,))

    employee = cursor.fetchone()

    connection.close()

    return dict(employee) if employee else None


# ============================================================
# DELETE EMPLOYEE COMPLETELY
# ============================================================

def delete_employee(employee_id):
    """
    Delete employee and all related attendance data.
    """

    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT employee_id
        FROM employees
        WHERE employee_id = ?
    """, (employee_id,))

    employee = cursor.fetchone()

    if employee is None:
        connection.close()
        return False

    cursor.execute("""
        DELETE FROM attendance_events
        WHERE employee_id = ?
    """, (employee_id,))

    cursor.execute("""
        DELETE FROM daily_attendance
        WHERE employee_id = ?
    """, (employee_id,))

    cursor.execute("""
        DELETE FROM leave_records
        WHERE employee_id = ?
    """, (employee_id,))

    cursor.execute("""
        DELETE FROM employees
        WHERE employee_id = ?
    """, (employee_id,))

    connection.commit()
    connection.close()

    return True


# ============================================================
# DELETE ATTENDANCE BY DATE
# ============================================================

def delete_attendance_by_date(attendance_date):
    """
    Delete attendance events and summaries for one date.

    Employee details are NOT deleted.
    Face embeddings are NOT deleted.
    """

    try:
        datetime.strptime(
            attendance_date,
            "%Y-%m-%d"
        )
    except ValueError:
        raise ValueError(
            "Invalid date format. Use YYYY-MM-DD."
        )

    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        DELETE FROM attendance_events
        WHERE event_date = ?
    """, (attendance_date,))

    events_deleted = cursor.rowcount

    cursor.execute("""
        DELETE FROM daily_attendance
        WHERE attendance_date = ?
    """, (attendance_date,))

    summaries_deleted = cursor.rowcount

    cursor.execute("""
        DELETE FROM leave_records
        WHERE leave_date = ?
    """, (attendance_date,))

    leaves_deleted = cursor.rowcount

    connection.commit()
    connection.close()

    return {
        "date": attendance_date,
        "events_deleted": events_deleted,
        "summaries_deleted": summaries_deleted,
        "leaves_deleted": leaves_deleted,
    }


# ============================================================
# TIME HELPERS
# ============================================================

def get_today():
    return datetime.now().strftime("%Y-%m-%d")


def get_current_time():
    return datetime.now().strftime("%H:%M:%S")


def time_to_minutes(time_string):
    if not time_string or ":" not in str(time_string):
        return 0
    parts = str(time_string).split(":")
    try:
        hour = int(parts[0])
        minute = int(parts[1])
        return hour * 60 + minute
    except (ValueError, IndexError):
        return 0


def calculate_time_difference(
    start_time,
    end_time
):
    start = time_to_minutes(start_time)
    end = time_to_minutes(end_time)

    difference = end - start

    if difference < 0:
        difference = 0

    return difference


# ============================================================
# ARRIVAL STATUS
# ============================================================

def calculate_arrival_status(
    first_in,
    shift_start
):
    arrival_minutes = time_to_minutes(
        first_in
    )

    shift_minutes = time_to_minutes(
        shift_start
    )

    difference = arrival_minutes - shift_minutes

    if difference < 0:
        return (
            "EARLY",
            abs(difference),
            0
        )

    if difference > 0:
        return (
            "LATE",
            0,
            difference
        )

    return (
        "ON_TIME",
        0,
        0
    )


# ============================================================
# EVENTS
# ============================================================

def get_today_events(employee_id):

    today = get_today()

    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            id,
            employee_id,
            event_date,
            event_time,
            event_type,
            created_at
        FROM attendance_events
        WHERE employee_id = ?
        AND event_date = ?
        ORDER BY event_time ASC, id ASC
    """, (
        employee_id,
        today
    ))

    events = cursor.fetchall()

    connection.close()

    return events


def get_events_by_date(
    employee_id,
    attendance_date
):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            id,
            employee_id,
            event_date,
            event_time,
            event_type,
            created_at
        FROM attendance_events
        WHERE employee_id = ?
        AND event_date = ?
        ORDER BY event_time ASC, id ASC
    """, (
        employee_id,
        attendance_date
    ))

    events = cursor.fetchall()

    connection.close()

    return events


def get_employee_events(
    employee_id,
    attendance_date=None
):
    connection = get_connection()
    cursor = connection.cursor()

    if attendance_date:

        cursor.execute("""
            SELECT
                id,
                employee_id,
                event_date,
                event_time,
                event_type,
                created_at
            FROM attendance_events
            WHERE employee_id = ?
            AND event_date = ?
            ORDER BY event_time ASC, id ASC
        """, (
            employee_id,
            attendance_date
        ))

    else:

        cursor.execute("""
            SELECT
                id,
                employee_id,
                event_date,
                event_time,
                event_type,
                created_at
            FROM attendance_events
            WHERE employee_id = ?
            ORDER BY
                event_date DESC,
                event_time DESC,
                id DESC
        """, (
            employee_id
        ))

    events = cursor.fetchall()

    connection.close()

    return events


# ============================================================
# CURRENT STATE
# ============================================================

def get_current_state(employee_id):

    events = get_today_events(
        employee_id
    )

    if not events:
        return "OUTSIDE"

    last_event = events[-1]

    if last_event["event_type"] == "IN":
        return "INSIDE"

    return "OUTSIDE"


def get_first_in(employee_id):

    events = get_today_events(
        employee_id
    )

    for event in events:

        if event["event_type"] == "IN":
            return event["event_time"]

    return None


# ============================================================
# EMAIL
# ============================================================

def send_arrival_notification(
    employee,
    first_in,
    status,
    early_minutes,
    late_minutes
):

    if not employee["email"]:

        print(
            "Employee email is not configured."
        )

        return False

    if status == "EARLY":

        return send_arrival_email(
            employee_name=employee["employee_name"],
            employee_email=employee["email"],
            shift_start=employee["shift_start"],
            first_in=first_in,
            status="EARLY",
            minutes=early_minutes,
            cc_email=employee["hr_email"]
        )

    if status == "LATE":

        return send_arrival_email(
            employee_name=employee["employee_name"],
            employee_email=employee["email"],
            shift_start=employee["shift_start"],
            first_in=first_in,
            status="LATE",
            minutes=late_minutes
        )

    return False


# ============================================================
# RECORD ENTRY
# ============================================================

def record_entry(
    employee_id,
    event_time=None
):

    employee = get_employee(
        employee_id
    )

    if employee is None:

        print(
            "Employee not found."
        )

        return False

    if event_time is None:
        event_time = get_current_time()

    today = get_today()

    current_state = get_current_state(
        employee_id
    )

    if current_state == "INSIDE":

        print()
        print("ENTRY IGNORED")
        print("-------------")
        print(
            f"Employee : {employee['employee_name']}"
        )
        print(
            "Reason   : Employee is already inside."
        )

        return False

    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        INSERT INTO attendance_events
        (
            employee_id,
            event_date,
            event_time,
            event_type,
            created_at
        )
        VALUES (?, ?, ?, ?, ?)
    """, (
        employee_id,
        today,
        event_time,
        "IN",
        datetime.now().isoformat()
    ))

    connection.commit()
    connection.close()

    first_in = get_first_in(
        employee_id
    )

    is_first_arrival = (
        first_in == event_time
    )

    print()
    print("ENTRY RECORDED")
    print("--------------")
    print(
        f"Employee : {employee['employee_name']}"
    )
    print(
        f"ID       : {employee_id}"
    )
    print(
        f"Time     : {event_time}"
    )

    if is_first_arrival:

        (
            status,
            early_minutes,
            late_minutes
        ) = calculate_arrival_status(
            first_in,
            employee["shift_start"]
        )

        print(
            f"Shift    : {employee['shift_start']}"
        )

        print(
            f"Status   : {status}"
        )

        if status == "EARLY":

            print(
                f"Early by : {early_minutes} minutes"
            )

        elif status == "LATE":

            print(
                f"Late by  : {late_minutes} minutes"
            )

        connection = get_connection()
        cursor = connection.cursor()

        cursor.execute("""
            INSERT INTO daily_attendance
            (
                employee_id,
                attendance_date,
                first_in,
                arrival_status,
                early_minutes,
                late_minutes
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(employee_id, attendance_date)
            DO UPDATE SET
                first_in = excluded.first_in,
                arrival_status = excluded.arrival_status,
                early_minutes = excluded.early_minutes,
                late_minutes = excluded.late_minutes
        """, (
            employee_id,
            today,
            first_in,
            status,
            early_minutes,
            late_minutes
        ))

        connection.commit()
        connection.close()

        if status in ("EARLY", "LATE"):

            print()
            print(
                "Sending arrival notification..."
            )

            email_sent = send_arrival_notification(
                employee,
                first_in,
                status,
                early_minutes,
                late_minutes
            )

            if email_sent:

                connection = get_connection()
                cursor = connection.cursor()

                cursor.execute("""
                    UPDATE daily_attendance
                    SET email_sent = 1
                    WHERE employee_id = ?
                    AND attendance_date = ?
                """, (
                    employee_id,
                    today
                ))

                connection.commit()
                connection.close()

                print(
                    "Arrival notification sent."
                )

    return True


# ============================================================
# RECORD EXIT
# ============================================================

def record_exit(
    employee_id,
    event_time=None
):

    employee = get_employee(
        employee_id
    )

    if employee is None:

        print(
            "Employee not found."
        )

        return False

    if event_time is None:
        event_time = get_current_time()

    today = get_today()

    current_state = get_current_state(
        employee_id
    )

    if current_state == "OUTSIDE":

        print()
        print("EXIT IGNORED")
        print("------------")
        print(
            f"Employee : {employee['employee_name']}"
        )
        print(
            "Reason   : Employee is already outside."
        )

        return False

    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        INSERT INTO attendance_events
        (
            employee_id,
            event_date,
            event_time,
            event_type,
            created_at
        )
        VALUES (?, ?, ?, ?, ?)
    """, (
        employee_id,
        today,
        event_time,
        "OUT",
        datetime.now().isoformat()
    ))

    connection.commit()
    connection.close()

    print()
    print("EXIT RECORDED")
    print("-------------")
    print(
        f"Employee : {employee['employee_name']}"
    )
    print(
        f"ID       : {employee_id}"
    )
    print(
        f"Time     : {event_time}"
    )

    summary = calculate_daily_summary(
        employee_id
    )

    print(
        f"Worked today : "
        f"{summary['worked_hours']}"
    )

    return True


# ============================================================
# WORK SESSIONS
# ============================================================

def calculate_sessions(employee_id):

    events = get_today_events(
        employee_id
    )

    return calculate_sessions_from_events(
        events
    )


def calculate_sessions_from_events(events):

    sessions = []
    open_in = None

    for event in events:

        if event["event_type"] == "IN":

            if open_in is None:
                open_in = event["event_time"]

        elif event["event_type"] == "OUT":

            if open_in is not None:

                minutes = calculate_time_difference(
                    open_in,
                    event["event_time"]
                )

                sessions.append({
                    "check_in": open_in,
                    "check_out": event["event_time"],
                    "worked_minutes": minutes,
                    "worked_hours": _format_worked_minutes(minutes),
                })

                open_in = None

    open_session = None

    if open_in is not None:

        open_session = {
            "check_in": open_in,
            "check_out": None,
            "worked_minutes": 0,
            "worked_hours": "0h 0m",
        }

    return sessions, open_session


# ============================================================
# DAILY SUMMARY
# ============================================================

def calculate_daily_summary(employee_id):

    employee = get_employee(
        employee_id
    )

    if employee is None:
        return None

    events = get_today_events(
        employee_id
    )

    sessions, open_session = calculate_sessions(
        employee_id
    )

    total_worked_minutes = sum(
        session["worked_minutes"]
        for session in sessions
    )

    first_in = None

    for event in events:

        if event["event_type"] == "IN":

            first_in = event["event_time"]
            break

    last_out = None

    for event in reversed(events):

        if event["event_type"] == "OUT":

            last_out = event["event_time"]
            break

    is_flexible = is_flexible_shift_employee(employee)

    arrival_status = None
    early_minutes = 0
    late_minutes = 0

    if is_flexible:
        if first_in:
            arrival_status = "FLEXIBLE"
    else:
        if first_in:
            (
                arrival_status,
                early_minutes,
                late_minutes
            ) = calculate_arrival_status(
                first_in,
                employee["shift_start"]
            )

    break_minutes = calculate_break_minutes(
        sessions,
        employee["shift_start"],
        employee["shift_end"],
        total_worked_minutes,
        is_flexible
    )
    break_duration = _format_worked_minutes(break_minutes)
    status = calculate_attendance_status(total_worked_minutes)

    worked_hours = (
        f"{total_worked_minutes // 60}h "
        f"{total_worked_minutes % 60}m"
    )

    return {
        "employee_id": employee_id,
        "employee_name": employee["employee_name"],
        "date": get_today(),
        "shift_start": "Flexible" if is_flexible else employee["shift_start"],
        "shift_end": "Flexible" if is_flexible else employee["shift_end"],
        "department": employee["department"] if "department" in employee.keys() else "",
        "work_location": employee["work_location"] if "work_location" in employee.keys() else "Miracle City (HQ)",
        "designation": employee["designation"] if "designation" in employee.keys() else "",
        "first_in": first_in,
        "last_out": last_out,
        "arrival_status": arrival_status,
        "early_minutes": early_minutes,
        "late_minutes": late_minutes,
        "worked_minutes": total_worked_minutes,
        "worked_hours": worked_hours,
        "break_minutes": break_minutes,
        "break_duration": break_duration,
        "status": status,
        "session_count": len(sessions),
        "is_flexible_shift": is_flexible,
        "sessions": sessions,
        "open_session": open_session,
        "current_state": get_current_state(
            employee_id
        ),
        "event_count": len(events)
    }


def get_daily_summary(employee_id):

    summary = calculate_daily_summary(
        employee_id
    )

    if summary is None:
        return None

    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        INSERT INTO daily_attendance
        (
            employee_id,
            attendance_date,
            first_in,
            last_out,
            arrival_status,
            early_minutes,
            late_minutes,
            worked_minutes,
            status,
            break_minutes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(employee_id, attendance_date)
        DO UPDATE SET
            first_in = excluded.first_in,
            last_out = excluded.last_out,
            arrival_status = excluded.arrival_status,
            early_minutes = excluded.early_minutes,
            late_minutes = excluded.late_minutes,
            worked_minutes = excluded.worked_minutes,
            status = excluded.status,
            break_minutes = excluded.break_minutes
    """, (
        employee_id,
        summary["date"],
        summary["first_in"],
        summary["last_out"],
        summary["arrival_status"],
        summary["early_minutes"],
        summary["late_minutes"],
        summary["worked_minutes"],
        summary["status"],
        summary["break_minutes"],
    ))

    connection.commit()
    connection.close()

    return summary


# ============================================================
# TODAY ATTENDANCE
# ============================================================

def get_today_attendance(department=None):

    connection = get_connection()
    cursor = connection.cursor()

    query = """
        SELECT
            employee_id,
            employee_name,
            shift_start,
            shift_end,
            email,
            login_id,
            hubble_id,
            reports_to,
            reports_to_mail_id,
            hr_contact,
            hr_email,
            department,
            designation,
            team_name,
            work_location,
            is_flexible_shift
        FROM employees
    """
    params = []
    if department and department.upper() != "ALL":
        query += " WHERE LOWER(department) = LOWER(?)"
        params.append(department.strip())

    query += " ORDER BY employee_id"
    cursor.execute(query, tuple(params))

    employees = cursor.fetchall()
    connection.close()

    results = []

    for employee in employees:

        summary = calculate_daily_summary(
            employee["employee_id"]
        )

        results.append(summary)

    return results


# ============================================================
# HISTORICAL ATTENDANCE
# ============================================================

def get_attendance_by_date(
    attendance_date,
    department=None
):

    try:

        datetime.strptime(
            attendance_date,
            "%Y-%m-%d"
        )

    except ValueError:

        raise ValueError(
            "Invalid date format. Use YYYY-MM-DD."
        )

    connection = get_connection()
    cursor = connection.cursor()

    query = """
        SELECT
            employee_id,
            employee_name,
            shift_start,
            shift_end,
            email,
            login_id,
            hubble_id,
            reports_to,
            reports_to_mail_id,
            hr_contact,
            hr_email,
            department,
            designation,
            team_name,
            work_location,
            is_flexible_shift
        FROM employees
    """
    params = []
    if department and department.upper() != "ALL":
        query += " WHERE LOWER(department) = LOWER(?)"
        params.append(department.strip())

    query += " ORDER BY employee_id"
    cursor.execute(query, tuple(params))

    employees = cursor.fetchall()

    cursor.execute("SELECT employee_id, leave_type, reason FROM leave_records WHERE leave_date = ?", (attendance_date,))
    leaves_by_emp = {row["employee_id"]: dict(row) for row in cursor.fetchall()}

    connection.close()

    results = []

    for employee in employees:

        events = get_events_by_date(
            employee["employee_id"],
            attendance_date
        )

        sessions, open_session = (
            calculate_sessions_from_events(
                events
            )
        )

        worked_minutes = sum(
            session["worked_minutes"]
            for session in sessions
        )

        worked_hours = (
            f"{worked_minutes // 60}h "
            f"{worked_minutes % 60}m"
        )

        first_in = None

        for event in events:

            if event["event_type"] == "IN":

                first_in = event["event_time"]
                break

        last_out = None

        for event in reversed(events):

            if event["event_type"] == "OUT":

                last_out = event["event_time"]
                break

        is_flexible = is_flexible_shift_employee(employee)

        arrival_status = None
        early_minutes = 0
        late_minutes = 0

        if is_flexible:
            if first_in:
                arrival_status = "FLEXIBLE"
        else:
            if first_in:
                (
                    arrival_status,
                    early_minutes,
                    late_minutes
                ) = calculate_arrival_status(
                    first_in,
                    employee["shift_start"]
                )

        current_date_obj = datetime.strptime(attendance_date, "%Y-%m-%d").date()
        is_weekend = current_date_obj.weekday() >= 5
        leave = leaves_by_emp.get(employee["employee_id"])

        status = calculate_attendance_status(worked_minutes, is_leave=bool(leave), is_weekend=is_weekend)

        break_minutes = calculate_break_minutes(
            sessions,
            employee["shift_start"],
            employee["shift_end"],
            worked_minutes,
            is_flexible
        )
        break_duration = _format_worked_minutes(break_minutes)

        current_state = "OUTSIDE"

        if events:

            last_event = events[-1]

            if last_event["event_type"] == "IN":
                current_state = "INSIDE"

        results.append({
            "employee_id": employee["employee_id"],
            "employee_name": employee["employee_name"],
            "date": attendance_date,
            "shift_start": "Flexible" if is_flexible else employee["shift_start"],
            "shift_end": "Flexible" if is_flexible else employee["shift_end"],
            "department": employee["department"] if "department" in employee.keys() else "",
            "work_location": employee["work_location"] if "work_location" in employee.keys() else "Miracle City (HQ)",
            "designation": employee["designation"] if "designation" in employee.keys() else "",
            "first_in": first_in,
            "last_out": last_out,
            "arrival_status": arrival_status,
            "early_minutes": early_minutes,
            "late_minutes": late_minutes,
            "worked_minutes": worked_minutes,
            "worked_hours": worked_hours,
            "break_minutes": break_minutes,
            "break_duration": break_duration,
            "status": status,
            "session_count": len(sessions),
            "is_flexible_shift": is_flexible,
            "leave_type": leave["leave_type"] if leave else None,
            "reason": leave["reason"] if leave else None,
            "sessions": sessions,
            "open_session": open_session,
            "current_state": current_state,
            "event_count": len(events)
        })

    return results


# ============================================================
# MONTHLY EMPLOYEE ATTENDANCE CALENDAR AND LEAVE
# ============================================================

def _format_worked_minutes(worked_minutes):
    worked_minutes = max(0, int(worked_minutes or 0))
    return f"{worked_minutes // 60}h {worked_minutes % 60}m"


def _scheduled_shift_minutes(shift_start, shift_end):
    start = time_to_minutes(shift_start)
    end = time_to_minutes(shift_end)
    if end <= start:
        end += 24 * 60
    return end - start


def _elapsed_minutes(start_time, end_time):
    difference = time_to_minutes(end_time) - time_to_minutes(start_time)
    return difference + 24 * 60 if difference < 0 else difference


def get_employee_attendance_history(employee_id, year, month):
    """Return calendar-ready attendance and leave records for one month."""
    import calendar
    from datetime import date

    if month < 1 or month > 12:
        raise ValueError("Month must be between 1 and 12.")
    if year < 2000 or year > 2100:
        raise ValueError("Year must be between 2000 and 2100.")

    employee = get_employee(employee_id)
    if employee is None:
        return None

    is_flexible = is_flexible_shift_employee(employee)

    first_date = f"{year:04d}-{month:02d}-01"
    last_day = calendar.monthrange(year, month)[1]
    last_date = f"{year:04d}-{month:02d}-{last_day:02d}"

    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute("""
            SELECT id, employee_id, event_date, event_time, event_type, created_at
            FROM attendance_events
            WHERE employee_id = ? AND event_date BETWEEN ? AND ?
            ORDER BY event_date ASC, event_time ASC, id ASC
        """, (employee_id, first_date, last_date))
        event_rows = cursor.fetchall()

        cursor.execute("""
            SELECT leave_date, leave_type, reason
            FROM leave_records
            WHERE employee_id = ? AND leave_date BETWEEN ? AND ?
            ORDER BY leave_date ASC
        """, (employee_id, first_date, last_date))
        leave_rows = cursor.fetchall()
    finally:
        connection.close()

    events_by_date = {}
    for row in event_rows:
        event = dict(row)
        events_by_date.setdefault(event["event_date"], []).append(event)

    leaves_by_date = {row["leave_date"]: dict(row) for row in leave_rows}
    attendance = []

    for day_number in range(1, last_day + 1):
        current_date = date(year, month, day_number)
        date_string = current_date.isoformat()
        events = events_by_date.get(date_string, [])
        leave = leaves_by_date.get(date_string)
        sessions, open_session = calculate_sessions_from_events(events)

        worked_minutes = sum(
            session["worked_minutes"]
            for session in sessions
        )

        is_weekend = current_date.weekday() >= 5
        status = calculate_attendance_status(worked_minutes, is_leave=bool(leave), is_weekend=is_weekend)

        first_in = next(
            (event["event_time"] for event in events if event["event_type"] == "IN"),
            None,
        )
        last_out = next(
            (event["event_time"] for event in reversed(events) if event["event_type"] == "OUT"),
            None,
        )

        arrival_status = None
        early_minutes = 0
        late_minutes = 0
        if is_flexible:
            if first_in:
                arrival_status = "FLEXIBLE"
        elif first_in:
            arrival_status, early_minutes, late_minutes = calculate_arrival_status(
                first_in, employee["shift_start"]
            )

        break_minutes = calculate_break_minutes(
            sessions,
            employee["shift_start"],
            employee["shift_end"],
            worked_minutes,
            is_flexible
        )
        break_duration = _format_worked_minutes(break_minutes)

        attendance.append({
            "date": date_string,
            "day": day_number,
            "weekday": current_date.strftime("%A"),
            "status": status,
            "first_in": first_in,
            "last_out": last_out,
            "worked_minutes": worked_minutes if status not in {"LEAVE", "WEEKEND", "ABSENT"} else 0,
            "worked_hours": _format_worked_minutes(worked_minutes) if status not in {"LEAVE", "WEEKEND", "ABSENT"} else "0h 0m",
            "break_minutes": break_minutes if status not in {"LEAVE", "WEEKEND", "ABSENT"} else 0,
            "break_duration": break_duration if status not in {"LEAVE", "WEEKEND", "ABSENT"} else "0h 0m",
            "session_count": len(sessions),
            "event_count": len(events),
            "is_flexible_shift": is_flexible,
            "arrival_status": arrival_status,
            "early_minutes": early_minutes,
            "late_minutes": late_minutes,
            "leave_type": leave["leave_type"] if leave else None,
            "reason": leave["reason"] if leave else None,
            "events": events,
            "sessions": sessions,
            "open_session": open_session,
        })

    return {
        "employee": {
            "employee_id": employee["employee_id"],
            "employee_name": employee["employee_name"],
            "email": employee["email"],
            "shift_start": "Flexible" if is_flexible else employee["shift_start"],
            "shift_end": "Flexible" if is_flexible else employee["shift_end"],
            "department": employee["department"] if "department" in employee.keys() else "",
            "work_location": employee["work_location"] if "work_location" in employee.keys() else "Miracle City (HQ)",
            "designation": employee["designation"] if "designation" in employee.keys() else "",
            "is_flexible_shift": is_flexible,
        },
        "year": year,
        "month": month,
        "attendance": attendance,
    }


# ============================================================
# SUPERIOR MANUAL ATTENDANCE CORRECTION
# ============================================================

def manual_attendance_correction(
    employee_id: str,
    attendance_date: str,
    status: str,
    first_in: str = None,
    last_out: str = None,
    worked_minutes: int = None,
    reason: str = None,
    actor_username: str = "superior",
    actor_role: str = "superior",
):
    """
    Manually correct any employee's attendance with before/after audit logging.
    Can mark employee present or absent even when no check-in was recorded.
    """
    try:
        datetime.strptime(attendance_date, "%Y-%m-%d")
    except ValueError:
        raise ValueError("Invalid date format. Use YYYY-MM-DD.")

    employee = get_employee(employee_id)
    if not employee:
        raise LookupError(f"Employee '{employee_id}' not found.")

    if not reason or not reason.strip():
        raise ValueError("A reason must be provided for manual attendance correction.")

    connection = get_connection()
    cursor = connection.cursor()

    # Capture before values
    cursor.execute("""
        SELECT first_in, last_out, arrival_status, worked_minutes, status, break_minutes
        FROM daily_attendance WHERE employee_id = ? AND attendance_date = ?
    """, (employee_id, attendance_date))
    existing_daily = cursor.fetchone()
    before_state = dict(existing_daily) if existing_daily else {"status": "NO_RECORD", "worked_minutes": 0}

    is_flexible = is_flexible_shift_employee(employee)
    norm_status = status.strip().upper()

    now_iso = datetime.now().isoformat()

    if norm_status == "ABSENT":
        # Remove events for this date
        cursor.execute("DELETE FROM attendance_events WHERE employee_id = ? AND event_date = ?", (employee_id, attendance_date))
        cursor.execute("""
            INSERT INTO daily_attendance (employee_id, attendance_date, first_in, last_out, arrival_status, early_minutes, late_minutes, worked_minutes, status, break_minutes)
            VALUES (?, ?, NULL, NULL, 'ABSENT', 0, 0, 0, 'ABSENT', 0)
            ON CONFLICT(employee_id, attendance_date) DO UPDATE SET
                first_in = NULL,
                last_out = NULL,
                arrival_status = 'ABSENT',
                early_minutes = 0,
                late_minutes = 0,
                worked_minutes = 0,
                status = 'ABSENT',
                break_minutes = 0
        """, (employee_id, attendance_date))
        after_state = {
            "status": "ABSENT",
            "worked_minutes": 0,
            "first_in": None,
            "last_out": None,
        }
    else:
        # Present / Full Day / Half Day
        resolved_in = first_in or (employee["shift_start"] if employee["shift_start"] and employee["shift_start"] != "Flexible" else "09:00")
        if not last_out:
            if norm_status == "HALF_DAY":
                # 4.5 hours later
                in_mins = time_to_minutes(resolved_in)
                out_mins = in_mins + 270
                resolved_out = f"{(out_mins // 60) % 24:02d}:{out_mins % 60:02d}"
            else:
                resolved_out = employee["shift_end"] if employee["shift_end"] and employee["shift_end"] != "Flexible" else "17:30"
        else:
            resolved_out = last_out

        if worked_minutes is None:
            calc_mins = calculate_time_difference(resolved_in, resolved_out)
            resolved_worked = calc_mins if calc_mins > 0 else (480 if norm_status in ("FULL_DAY", "PRESENT") else 240)
        else:
            resolved_worked = int(worked_minutes)

        final_status = calculate_attendance_status(resolved_worked)
        if norm_status in ("FULL_DAY", "HALF_DAY") and final_status == "ABSENT":
            final_status = norm_status

        # Update events
        cursor.execute("DELETE FROM attendance_events WHERE employee_id = ? AND event_date = ?", (employee_id, attendance_date))
        cursor.execute("""
            INSERT INTO attendance_events (employee_id, event_date, event_time, event_type, created_at)
            VALUES (?, ?, ?, 'IN', ?)
        """, (employee_id, attendance_date, resolved_in, now_iso))
        cursor.execute("""
            INSERT INTO attendance_events (employee_id, event_date, event_time, event_type, created_at)
            VALUES (?, ?, ?, 'OUT', ?)
        """, (employee_id, attendance_date, resolved_out, now_iso))

        break_mins = calculate_break_minutes(
            [{"check_in": resolved_in, "check_out": resolved_out, "worked_minutes": resolved_worked}],
            employee["shift_start"],
            employee["shift_end"],
            resolved_worked,
            is_flexible
        )

        arr_status = "FLEXIBLE" if is_flexible else "ON_TIME"

        cursor.execute("""
            INSERT INTO daily_attendance (employee_id, attendance_date, first_in, last_out, arrival_status, early_minutes, late_minutes, worked_minutes, status, break_minutes)
            VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
            ON CONFLICT(employee_id, attendance_date) DO UPDATE SET
                first_in = excluded.first_in,
                last_out = excluded.last_out,
                arrival_status = excluded.arrival_status,
                early_minutes = 0,
                late_minutes = 0,
                worked_minutes = excluded.worked_minutes,
                status = excluded.status,
                break_minutes = excluded.break_minutes
        """, (employee_id, attendance_date, resolved_in, resolved_out, arr_status, resolved_worked, final_status, break_mins))

        after_state = {
            "status": final_status,
            "worked_minutes": resolved_worked,
            "first_in": resolved_in,
            "last_out": resolved_out,
        }

    # Record in audit log
    cursor.execute("""
        INSERT INTO audit_logs (actor_username, actor_role, action_type, target_id, target_date, before_value, after_value, reason, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        actor_username,
        actor_role,
        "MANUAL_ATTENDANCE_CORRECTION",
        employee_id,
        attendance_date,
        json.dumps(before_state),
        json.dumps(after_state),
        reason.strip(),
        now_iso,
    ))

    connection.commit()
    connection.close()

    return {
        "success": True,
        "employee_id": employee_id,
        "attendance_date": attendance_date,
        "before": before_state,
        "after": after_state,
        "reason": reason.strip(),
    }


def add_leave(employee_id, leave_date, leave_type="Leave", reason=None):
    if get_employee(employee_id) is None:
        return False
    try:
        datetime.strptime(leave_date, "%Y-%m-%d")
    except (TypeError, ValueError) as error:
        raise ValueError("Invalid leave date. Use YYYY-MM-DD.") from error

    connection = get_connection()
    try:
        connection.execute("""
            INSERT INTO leave_records (employee_id, leave_date, leave_type, reason, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(employee_id, leave_date) DO UPDATE SET
                leave_type = excluded.leave_type,
                reason = excluded.reason,
                created_at = excluded.created_at
        """, (
            employee_id,
            leave_date,
            (leave_type or "Leave").strip() or "Leave",
            reason,
            datetime.now().isoformat(),
        ))
        connection.commit()
    finally:
        connection.close()
    return get_leave(employee_id, leave_date)


def get_leave(employee_id, leave_date):
    connection = get_connection()
    try:
        row = connection.execute("""
            SELECT id, employee_id, leave_date, leave_type, reason, created_at
            FROM leave_records WHERE employee_id = ? AND leave_date = ?
        """, (employee_id, leave_date)).fetchone()
        return dict(row) if row else None
    finally:
        connection.close()


def delete_leave(employee_id, leave_date):
    connection = get_connection()
    try:
        cursor = connection.execute(
            "DELETE FROM leave_records WHERE employee_id = ? AND leave_date = ?",
            (employee_id, leave_date),
        )
        connection.commit()
        return cursor.rowcount > 0
    finally:
        connection.close()


# ============================================================
# BACKWARD COMPATIBILITY
# ============================================================

def check_employee_attendance(employee_id):

    return record_entry(
        employee_id
    )


# ============================================================
# INITIALIZE DATABASE
# ============================================================

create_database()


# ============================================================
# DIRECT TEST
# ============================================================

if __name__ == "__main__":

    print()
    print("======================================")
    print("Event-Based Attendance System")
    print("======================================")
    print()
    print("Database initialized.")
    print()
    print("Available functions:")
    print("record_entry(employee_id)")
    print("record_exit(employee_id)")
    print("get_current_state(employee_id)")
    print("calculate_sessions(employee_id)")
    print("calculate_daily_summary(employee_id)")
    print("get_today_attendance()")
    print("get_attendance_by_date('YYYY-MM-DD')")
    print("get_employee_events(employee_id)")
    print("delete_employee(employee_id)")
    print("delete_attendance_by_date('YYYY-MM-DD')")