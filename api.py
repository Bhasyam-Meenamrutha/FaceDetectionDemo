import os
import pickle
import shutil
import sqlite3
import threading

import cv2
import httpx
import numpy as np
from dotenv import load_dotenv

from datetime import datetime

from fastapi import (
    FastAPI,
    HTTPException,
    UploadFile,
    File,
    Query,
    Header,
    Depends,
    status
)
from fastapi.responses import StreamingResponse

from fastapi.concurrency import run_in_threadpool

from fastapi.middleware.cors import CORSMiddleware

from pydantic import BaseModel

from camera_manager import (
    delete_camera,
    get_camera,
    list_cameras,
    open_camera,
    save_camera,
    register_camera_preview,
    stop_camera_preview,
    set_camera_enabled,
)

from insightface.app import FaceAnalysis
from insightface.app.common import Face

from attendance import (
    get_connection,
    add_employee,
    get_employee,
    delete_attendance_by_date,
    record_entry,
    record_exit,
    get_today_attendance,
    get_employee_events,
    get_daily_summary,
    get_attendance_by_date,
    get_employee_attendance_history,
    add_leave,
    get_leave,
    delete_leave,
    get_user_by_username,
    create_user,
    update_user_password,
    list_users,
    create_audit_log,
    get_audit_logs,
    create_session,
    get_session,
    delete_session,
    get_departments_list,
    manual_attendance_correction,
    verify_password,
    is_flexible_shift_employee,
    map_designation_to_role,
)
from report_service import (
    create_employee_report,
    create_all_employees_report,
    XLSX_MEDIA_TYPE,
)



# ============================================================
# PROJECT PATHS
# ============================================================

BASE_DIR = os.path.dirname(
    os.path.abspath(__file__)
)

load_dotenv(os.path.join(BASE_DIR, ".env"))

DATABASE = os.path.join(
    BASE_DIR,
    "attendance.db"
)

EMBEDDINGS_FILE = os.path.join(
    BASE_DIR,
    "data",
    "embeddings",
    "face_embeddings.pkl"
)

FACES_DIRECTORY = os.path.join(
    BASE_DIR,
    "data",
    "faces_v2"
)

HUBBLE_API_URL = os.getenv(
    "HUBBLE_API_URL",
    "http://127.0.0.1:8001",
).rstrip("/")


def cameras_for_role(role):
    return [camera for camera in list_cameras(enabled_only=True) if role in camera["roles"]]


def camera_source_details(role):
    cameras = cameras_for_role(role)
    return ", ".join(camera["name"] for camera in cameras) or "No camera assigned"


# ============================================================
# INSIGHTFACE
# ============================================================

print("Loading InsightFace model...")

face_app = FaceAnalysis(
    name="buffalo_l"
)

face_app.prepare(
    ctx_id=-1,
    det_size=(320, 320)
)

print("InsightFace model loaded.")


# ============================================================
# FASTAPI
# ============================================================

app = FastAPI(
    title="Employee Attendance API",
    description=(
        "Backend API for the Employee Attendance System"
    ),
    version="7.0.0"
)


# ============================================================
# CORS
# ============================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from app.mock_hubble import router as mock_hubble_router
app.include_router(mock_hubble_router)


# ============================================================
# PYDANTIC MODELS
# ============================================================

class EmployeeCreate(BaseModel):

    employee_id: str
    employee_name: str = ""
    shift_start: str = "14:00"
    shift_end: str = "22:00"
    email: str = ""
    login_id: str = ""
    department: str = ""
    work_location: str = "Miracle City (HQ)"
    is_flexible_shift: bool = False


class LoginRequest(BaseModel):
    login_type: str | None = None  # "superior", "admin", or "hr"
    username: str
    password: str
    department: str | None = None


class ChangePasswordRequest(BaseModel):
    old_password: str | None = None
    current_password: str | None = None
    new_password: str


class CreateAdminRequest(BaseModel):
    username: str
    password: str
    display_name: str | None = None


class CreateHrRequest(BaseModel):
    department: str
    username: str
    password: str
    display_name: str | None = None


class ManualAttendanceCorrectionRequest(BaseModel):
    employee_id: str
    attendance_date: str | None = None
    date: str | None = None
    status: str
    first_in: str | None = None
    last_out: str | None = None
    worked_minutes: int | None = None
    worked_hours: float | int | str | None = None
    reason: str


class DepartmentUpdateRequest(BaseModel):
    department: str


class AttendanceEventCreate(BaseModel):

    employee_id: str


class EmployeeShiftUpdate(BaseModel):
    shift_start: str = "09:00"
    shift_end: str = "17:00"
    is_flexible_shift: bool = False


def get_current_user_optional(authorization: str | None = Header(None), token: str | None = Query(None)):
    raw_token = None
    if authorization and authorization.strip():
        if authorization.lower().startswith("bearer "):
            raw_token = authorization.split(" ", 1)[1].strip()
        else:
            raw_token = authorization.strip()
    elif token and token.strip():
        raw_token = token.strip()

    if not raw_token:
        return None

    sess = get_session(raw_token)
    if not sess:
        return None
    user = get_user_by_username(sess["username"])
    return user


def require_current_user(authorization: str | None = Header(None), token: str | None = Query(None)):
    user = get_current_user_optional(authorization=authorization, token=token)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired or invalid. Please log in again."
        )
    return user


class LeaveCreate(BaseModel):
    employee_id: str
    leave_date: str
    leave_type: str = "Leave"
    reason: str | None = None


class CameraConfig(BaseModel):
    name: str
    source_type: str
    source: str | None = None
    roles: list[str] = []
    enabled: bool = True


class CameraEnabledUpdate(BaseModel):
    enabled: bool


# ============================================================
# HOME
# ============================================================

@app.get("/")
def home():

    return {
        "message":
            "Employee Attendance API is running",

        "version":
            "7.0.0",

        "architecture":
            "multi-camera"
    }


# ============================================================
# MULTI-CAMERA MANAGEMENT
# ============================================================

@app.get("/cameras")
def get_cameras(role: str | None = Query(default=None)):
    cameras = list_cameras()
    if role:
        role = role.strip().upper()
        cameras = [camera for camera in cameras if role in camera["roles"]]
    return cameras


@app.get("/cameras/status")
def cameras_status():
    cameras = list_cameras()
    return {
        "architecture": "multi-camera",
        "cameras": cameras,
        "entry_cameras": [camera for camera in cameras if "ENTRY" in camera["roles"]],
        "exit_cameras": [camera for camera in cameras if "EXIT" in camera["roles"]],
    }


@app.post("/cameras")
def create_camera(config: CameraConfig):
    try:
        if not config.source:
            raise ValueError("Camera source is required.")
        return save_camera(
            name=config.name,
            source_type=config.source_type,
            source=config.source,
            roles=config.roles,
            enabled=config.enabled,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.put("/cameras/{camera_id}")
def update_camera(camera_id: str, config: CameraConfig):
    current = get_camera(camera_id)
    if current is None:
        raise HTTPException(status_code=404, detail="Camera not found.")
    try:
        return save_camera(
            camera_id=camera_id,
            name=config.name,
            source_type=config.source_type,
            source=config.source or current["source"],
            roles=config.roles,
            enabled=config.enabled,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.patch("/cameras/{camera_id}/enabled")
def update_camera_enabled(camera_id: str, config: CameraEnabledUpdate):
    camera = set_camera_enabled(camera_id, config.enabled)
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found.")
    return camera


@app.delete("/cameras/{camera_id}")
def remove_camera(camera_id: str):
    if not delete_camera(camera_id):
        raise HTTPException(status_code=404, detail="Camera not found.")
    return {"message": "Camera deleted."}


def _probe_camera(camera):
    source = open_camera(camera)
    try:
        if not source.isOpened():
            return False
        success, frame = source.read()
        return bool(success and frame is not None)
    finally:
        source.release()


@app.post("/cameras/{camera_id}/test")
async def test_camera(camera_id: str):
    camera = get_camera(camera_id)
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found.")
    if not camera["enabled"]:
        raise HTTPException(status_code=409, detail="Camera is disabled.")
    try:
        connected = await run_in_threadpool(_probe_camera, camera)
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"Camera connection failed: {error}") from error
    if not connected:
        raise HTTPException(status_code=502, detail="Camera did not provide a frame.")
    return {"connected": True}


def _camera_mjpeg_frames(camera, stream_id):
    current = get_camera(camera["id"])
    if current is None or not current["enabled"]:
        return
    source = open_camera(camera)
    stop_event = threading.Event()
    register_camera_preview(camera["id"], stream_id, source, stop_event)
    try:
        current = get_camera(camera["id"])
        if current is None or not current["enabled"]:
            stop_event.set()
            return
        if not source.isOpened():
            return
        while not stop_event.is_set():
            success, frame = source.read()
            if stop_event.is_set() or not success or frame is None:
                break
            encoded, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if encoded:
                yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + buffer.tobytes() + b"\r\n"
    finally:
        stop_event.set()
        stop_camera_preview(camera["id"], stream_id)
        source.release()


@app.get("/cameras/{camera_id}/stream.mjpg")
def stream_camera(camera_id: str, stream_id: str = Query(..., min_length=1, max_length=100)):
    camera = get_camera(camera_id)
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found.")
    if not camera["enabled"]:
        raise HTTPException(status_code=409, detail="Camera is disabled.")
    return StreamingResponse(
        _camera_mjpeg_frames(camera, stream_id),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@app.post("/cameras/{camera_id}/stream/{stream_id}/stop")
def stop_camera_stream(camera_id: str, stream_id: str):
    stopped = stop_camera_preview(camera_id, stream_id)
    return {"stopped": stopped}


# ============================================================
# GET ALL EMPLOYEES
# ============================================================

@app.post("/auth/login")
def login(req: LoginRequest):
    username = (req.username or "").strip()
    password = (req.password or "").strip()

    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
    if not password:
        raise HTTPException(status_code=400, detail="Password is required")

    user = get_user_by_username(username)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials.")

    if not verify_password(password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials.")

    # Determine authorized role from the database account configuration
    role = (user.get("role") or "").strip().lower()
    if not role or role not in ("superior", "admin", "hr"):
        desig_role = map_designation_to_role(user.get("display_name") or "")
        role = desig_role if desig_role in ("superior", "admin", "hr") else "hr"

    # If role-assertion was sent by legacy client/test, verify authorized role matches
    if req.login_type:
        req_role = req.login_type.lower().strip()
        if req_role not in ("superior", "admin", "hr"):
            raise HTTPException(status_code=400, detail="Invalid login type. Allowed: Superior, Admin, HR")
        if role != req_role:
            raise HTTPException(status_code=401, detail=f"User '{username}' is not authorized as {req_role.capitalize()}.")

    # Determine authorized department scope from the database account configuration
    if role == "hr":
        assigned_dept = (user.get("department") or "Software Services").strip()
        req_dept = (req.department or "").strip()
        if req_dept and req_dept.lower() != assigned_dept.lower():
            raise HTTPException(
                status_code=403,
                detail=f"Unauthorized: Account is authorized for '{assigned_dept}', not '{req_dept}'."
            )
        department = assigned_dept
    else:
        department = "ALL"

    token = create_session(user["username"], role, department)

    return {
        "ok": True,
        "role": role,
        "username": user["username"],
        "department": department,
        "displayName": user.get("display_name") or user["username"],
        "token": token,
        "must_change_password": bool(user.get("must_change_password")),
    }



@app.post("/auth/change-password")
def change_password(req: ChangePasswordRequest, current_user = Depends(require_current_user)):
    old_pass = req.old_password or req.current_password or ""
    if not verify_password(old_pass, current_user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password does not match.")
    try:
        update_user_password(current_user["username"], req.new_password, actor_username=current_user["username"])
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    return {"ok": True, "message": "Password updated successfully."}


@app.post("/admin/create-admin")
def create_admin_account(req: CreateAdminRequest, current_user = Depends(require_current_user)):
    if current_user["role"] != "superior":
        raise HTTPException(status_code=403, detail="Only Superior accounts are authorized to generate Admin credentials.")
    try:
        created = create_user(
            username=req.username,
            password=req.password,
            role="admin",
            department="ALL",
            display_name=req.display_name or f"Admin ({req.username.strip()})",
            must_change_password=1,
            created_by=current_user["username"],
        )
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))

    return {
        "ok": True,
        "message": "Admin credentials generated successfully. Admin must change password upon first login.",
        "user": {
            "username": created["username"],
            "role": created["role"],
            "displayName": created["display_name"],
            "must_change_password": True,
        },
    }


@app.post("/admin/create-hr")
def create_hr_account(req: CreateHrRequest, current_user = Depends(require_current_user)):
    if current_user["role"] not in ("superior", "admin"):
        raise HTTPException(status_code=403, detail="Only Administrator or Superior accounts can generate HR credentials.")
    if not req.department or not req.department.strip():
        raise HTTPException(status_code=400, detail="Authorized department is required for HR credentials.")
    try:
        created = create_user(
            username=req.username,
            password=req.password,
            role="hr",
            department=req.department.strip(),
            display_name=req.display_name or f"HR ({req.department.strip()})",
            must_change_password=0,
            created_by=current_user["username"],
        )
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))

    return {
        "ok": True,
        "message": "HR credentials created successfully.",
        "user": {
            "username": created["username"],
            "role": created["role"],
            "department": created["department"],
            "displayName": created["display_name"],
        },
    }


@app.get("/admin/users")
def get_admin_users(current_user = Depends(require_current_user)):
    if current_user["role"] == "superior":
        return list_users()
    elif current_user["role"] == "admin":
        return list_users(role="hr")
    else:
        raise HTTPException(status_code=403, detail="Access denied.")


@app.get("/audit/logs")
def get_activity_audit_logs(
    actor_role: str | None = None,
    action_type: str | None = None,
    target_date: str | None = None,
    limit: int = 200,
    current_user = Depends(require_current_user)
):
    if current_user["role"] != "superior":
        raise HTTPException(status_code=403, detail="Only Superior accounts have access to system and admin activity logs.")
    return get_audit_logs(limit=limit, actor_role=actor_role, action_type=action_type, target_date=target_date)


@app.post("/attendance/manual-correction")
def manual_attendance_override(req: ManualAttendanceCorrectionRequest, current_user = Depends(require_current_user)):
    if current_user["role"] != "superior":
        raise HTTPException(status_code=403, detail="Only Superior accounts are authorized to manually correct employee attendance.")
    target_date = req.attendance_date or req.date
    if not target_date:
        raise HTTPException(status_code=400, detail="attendance_date is required")

    wm = req.worked_minutes
    if wm is None and req.worked_hours is not None:
        try:
            wm = int(float(req.worked_hours) * 60)
        except Exception:
            wm = 0

    try:
        res = manual_attendance_correction(
            employee_id=req.employee_id,
            attendance_date=target_date,
            status=req.status,
            first_in=req.first_in,
            last_out=req.last_out,
            worked_minutes=wm,
            reason=req.reason,
            actor_username=current_user["username"],
            actor_role=current_user["role"],
        )
        return res
    except LookupError as err:
        raise HTTPException(status_code=404, detail=str(err))
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))


@app.get("/departments")
def get_departments():
    return get_departments_list()


@app.get("/locations")
def get_locations():
    connection = get_connection()
    cursor = connection.cursor()
    cursor.execute("""
        SELECT DISTINCT work_location FROM employees WHERE work_location IS NOT NULL AND work_location != ''
    """)
    rows = cursor.fetchall()
    connection.close()

    db_locs = [row["work_location"] for row in rows if row["work_location"]]
    defaults = [
        "Miracle City (HQ)",
        "Miracle Valley",
        "Tech Center",
        "Remote / Field",
    ]
    combined = sorted(list(set(db_locs + defaults)))
    return combined


@app.get("/employees")
def get_employees(
    department: str | None = Query(None),
    location: str | None = Query(None),
    current_user = Depends(get_current_user_optional),
):
    if current_user and current_user["role"] == "hr":
        user_dept = (current_user["department"] or "").strip()
        if department and department.upper() != "ALL" and department.lower() != user_dept.lower():
            raise HTTPException(
                status_code=403,
                detail=f"Unauthorized: HR access is restricted to department '{user_dept}'."
            )
        department = user_dept

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
        WHERE 1=1
    """
    params = []

    if department and department.upper() != "ALL":
        query += " AND LOWER(department) = LOWER(?)"
        params.append(department.strip())

    if location and location.upper() != "ALL":
        query += " AND LOWER(work_location) = LOWER(?)"
        params.append(location.strip())

    query += " ORDER BY employee_id"
    cursor.execute(query, tuple(params))

    employees = cursor.fetchall()
    connection.close()

    result = []
    for employee in employees:
        d = dict(employee)
        is_flex = bool(d.get("is_flexible_shift") or is_flexible_shift_employee(d.get("designation"), d.get("is_flexible_shift")))
        d["is_flexible_shift"] = is_flex
        result.append(d)

    return result


@app.put("/employees/{employee_id}/department")
def update_employee_department(
    employee_id: str,
    payload: DepartmentUpdateRequest,
    current_user = Depends(get_current_user_optional),
):
    emp = get_employee(employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail="Employee not found")

    if current_user and current_user["role"] == "hr":
        raise HTTPException(status_code=403, detail="HR accounts are not authorized to transfer employee departments.")

    connection = get_connection()
    cursor = connection.cursor()
    cursor.execute(
        "UPDATE employees SET department = ? WHERE employee_id = ?",
        (payload.department.strip(), employee_id),
    )
    connection.commit()
    connection.close()

    emp = dict(emp)
    if current_user:
        create_audit_log(
            actor_username=current_user["username"],
            actor_role=current_user["role"],
            action_type="DEPARTMENT_UPDATE",
            target_employee_id=employee_id,
            details=f"Changed department from '{emp.get('department')}' to '{payload.department.strip()}'"
        )

    return {"message": "Department updated successfully", "department": payload.department.strip()}



# ============================================================
# CREATE EMPLOYEE
# ============================================================

def sync_hubble_employee(login_id: str):
    if not login_id:
        return {}

    # 1. Try external Hubble service (port 8001) if available
    try:
        response = httpx.post(
            f"{HUBBLE_API_URL}/api/employees/sync/{login_id}",
            timeout=3.0,
        )
        if response.is_success:
            return response.json().get("data", {})
    except Exception:
        pass

    # 2. Local fallback: load directly from mock_employees.json and enrich
    try:
        from app.mock_hubble import load_employees
        from pathlib import Path
        import json
        for emp in load_employees():
            if emp.get("loginId", "").casefold() == login_id.casefold():
                result = dict(emp)
                dir_path = Path(__file__).resolve().parent / "data" / "employee_directory.json"
                if dir_path.exists():
                    try:
                        with dir_path.open("r", encoding="utf-8") as f:
                            people = json.load(f)
                            email_map = {p.get("name", "").casefold(): p.get("mailId") for p in people}
                            if result.get("reportsTo") and not result.get("reportsToMailId"):
                                result["reportsToMailId"] = email_map.get(result["reportsTo"].casefold())
                            if result.get("hrContact") and not result.get("hrEmail"):
                                result["hrEmail"] = email_map.get(result["hrContact"].casefold())
                    except Exception:
                        pass
                return result
    except Exception:
        pass

    return {}


@app.get("/hubble/status")
def hubble_status():
    try:
        response = httpx.get(f"{HUBBLE_API_URL}/", timeout=5.0)
        return {
            "configured": True,
            "url": HUBBLE_API_URL,
            "available": response.is_success,
            "response": response.json() if response.is_success else None,
        }
    except httpx.HTTPError as error:
        return {
            "configured": True,
            "url": HUBBLE_API_URL,
            "available": False,
            "error": str(error),
        }

@app.post("/employees")
def create_employee(
    employee: EmployeeCreate
):

    employee_id = employee.employee_id.strip()
    login_id = employee.login_id.strip()

    if not employee_id:
        raise HTTPException(status_code=400, detail="employee_id is required")

    # --------------------------------------------------------
    # VALIDATE SHIFTS (Skip HH:MM requirement if flexible shift)
    # --------------------------------------------------------

    if not employee.is_flexible_shift:
        try:
            datetime.strptime(employee.shift_start, "%H:%M")
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=400,
                detail="shift_start must use HH:MM format, e.g. 14:00"
            )

        try:
            datetime.strptime(employee.shift_end, "%H:%M")
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=400,
                detail="shift_end must use HH:MM format, e.g. 22:00"
            )

    # --------------------------------------------------------
    # CHECK EXISTING EMPLOYEE
    # --------------------------------------------------------

    connection = get_connection()
    cursor = connection.cursor()
    cursor.execute("SELECT employee_id FROM employees WHERE TRIM(employee_id)=TRIM(?)", (employee_id,))
    existing_employee = cursor.fetchone()
    connection.close()
    if existing_employee:
        raise HTTPException(status_code=409, detail="Employee already exists")

    hubble_data = sync_hubble_employee(login_id) if login_id else {}
    employee_name = str(
        hubble_data.get("name") or employee.employee_name
    ).strip()
    email = str(
        hubble_data.get("mailId") or employee.email
    ).strip()

    if not employee_name:
        raise HTTPException(
            status_code=400,
            detail="employee_name is required when Hubble sync is not used",
        )

    shift_start_val = "Flexible" if employee.is_flexible_shift else employee.shift_start
    shift_end_val = "Flexible" if employee.is_flexible_shift else employee.shift_end

    add_employee(
        employee_id=employee_id,
        employee_name=employee_name,
        shift_start=shift_start_val,
        shift_end=shift_end_val,
        email=email,
        login_id=hubble_data.get("loginId") or login_id or None,
        hubble_id=(
            str(hubble_data["id"])
            if hubble_data.get("id") is not None
            else None
        ),
        reports_to=hubble_data.get("reportsTo"),
        reports_to_mail_id=hubble_data.get("reportsToMailId"),
        hr_contact=hubble_data.get("hrContact"),
        hr_email=hubble_data.get("hrEmail"),
        department=employee.department or hubble_data.get("department"),
        designation=hubble_data.get("designation"),
        team_name=hubble_data.get("teamName"),
        work_location=employee.work_location or "Miracle City (HQ)",
        is_flexible_shift=employee.is_flexible_shift,
    )
    return {
        "message": "Employee created successfully",
        "employee": {
            "employee_id": employee_id,
            "employee_name": employee_name,
            "shift_start": shift_start_val,
            "shift_end": shift_end_val,
            "email": email,
            "login_id": hubble_data.get("loginId") or login_id or None,
            "department": employee.department or hubble_data.get("department"),
            "work_location": employee.work_location or "Miracle City (HQ)",
            "is_flexible_shift": employee.is_flexible_shift,
            "hubble": hubble_data or None,
        },
    }


@app.put("/employees/{employee_id}/shift")
def update_employee_shift(
    employee_id: str,
    shift: EmployeeShiftUpdate,
    current_user = Depends(get_current_user_optional),
):
    emp = get_employee(employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")

    if current_user and current_user["role"] == "hr":
        emp_dept = str(emp["department"] or "")
        hr_dept = str(current_user["department"] or "")
        if emp_dept.lower() != hr_dept.lower():
            raise HTTPException(status_code=403, detail="Unauthorized: Cannot modify employee outside assigned department.")

    if shift.is_flexible_shift:
        shift_start = shift.shift_start if shift.shift_start and shift.shift_start != "Flexible" else "Flexible"
        shift_end = shift.shift_end if shift.shift_end and shift.shift_end != "Flexible" else "Flexible"
        is_flex_val = 1
    else:
        for field_name, value in (
            ("shift_start", shift.shift_start),
            ("shift_end", shift.shift_end),
        ):
            try:
                parsed_value = datetime.strptime(value, "%H:%M")
                if parsed_value.strftime("%H:%M") != value:
                    raise ValueError("Shift time must be zero-padded.")
            except (TypeError, ValueError) as error:
                raise HTTPException(
                    status_code=400,
                    detail=f"{field_name} must use HH:MM format, for example 09:30",
                ) from error
        shift_start = shift.shift_start
        shift_end = shift.shift_end
        is_flex_val = 0

    connection = get_connection()
    try:
        cursor = connection.execute(
            "UPDATE employees SET shift_start = ?, shift_end = ?, is_flexible_shift = ? WHERE employee_id = ?",
            (shift_start, shift_end, is_flex_val, employee_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")
        connection.commit()
        updated = connection.execute(
            """SELECT employee_id, employee_name, shift_start, shift_end,
                      email, login_id, hubble_id, reports_to, reports_to_mail_id,
                      hr_contact, hr_email, department, designation, team_name,
                      work_location, is_flexible_shift
               FROM employees WHERE employee_id = ?""",
            (employee_id,),
        ).fetchone()

        if current_user:
            create_audit_log(
                actor_username=current_user["username"],
                actor_role=current_user["role"],
                action_type="SHIFT_UPDATE",
                target_employee_id=employee_id,
                details=f"Updated shift: start={shift_start}, end={shift_end}, flexible={bool(is_flex_val)}"
            )

        updated_dict = dict(updated)
        updated_dict["is_flexible_shift"] = bool(updated_dict.get("is_flexible_shift") or is_flexible_shift_employee(updated_dict.get("designation"), updated_dict.get("is_flexible_shift")))
        return {
            "success": True,
            "message": "Employee shift updated successfully",
            "employee": updated_dict,
        }
    finally:
        connection.close()


# ============================================================
# DELETE EMPLOYEE COMPLETELY
# ============================================================

@app.delete("/employees/{employee_id}")
def remove_employee(employee_id: str, current_user = Depends(get_current_user_optional)):
    """Completely delete an employee and related attendance/face data."""
    emp = get_employee(employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail="Employee not found")

    if current_user and current_user["role"] == "hr":
        emp_dept = str(emp["department"] or "")
        hr_dept = str(current_user["department"] or "")
        if emp_dept.lower() != hr_dept.lower():
            raise HTTPException(status_code=403, detail="Unauthorized: Cannot delete employee outside assigned department.")

    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    cursor = connection.cursor()
    cursor.execute("SELECT employee_id FROM employees WHERE TRIM(employee_id)=TRIM(?)", (employee_id,))
    employee = cursor.fetchone()
    if employee is None:
        connection.close()
        raise HTTPException(status_code=404, detail="Employee not found")

    stored_id = employee["employee_id"]
    cursor.execute("DELETE FROM attendance_events WHERE TRIM(employee_id)=TRIM(?)", (stored_id,))
    cursor.execute("DELETE FROM daily_attendance WHERE TRIM(employee_id)=TRIM(?)", (stored_id,))
    cursor.execute("DELETE FROM leave_records WHERE TRIM(employee_id)=TRIM(?)", (stored_id,))
    cursor.execute("DELETE FROM employees WHERE TRIM(employee_id)=TRIM(?)", (stored_id,))
    connection.commit()
    connection.close()

    if os.path.exists(EMBEDDINGS_FILE):
        try:
            with open(EMBEDDINGS_FILE, "rb") as embedding_file:
                embeddings = pickle.load(embedding_file)
            if isinstance(embeddings, dict):
                for key in list(embeddings):
                    if str(key).strip() == str(stored_id).strip():
                        del embeddings[key]
                with open(EMBEDDINGS_FILE, "wb") as embedding_file:
                    pickle.dump(embeddings, embedding_file)
        except (OSError, pickle.PickleError):
            pass

    employee_directory = os.path.join(FACES_DIRECTORY, str(stored_id))
    if os.path.isdir(employee_directory):
        shutil.rmtree(employee_directory)

    emp = dict(emp)
    if current_user:
        create_audit_log(
            actor_username=current_user["username"],
            actor_role=current_user["role"],
            action_type="EMPLOYEE_DELETE",
            target_employee_id=employee_id,
            details=f"Deleted employee record: {emp.get('employee_name')} ({employee_id})"
        )
    return {"message": "Employee and related attendance data deleted successfully"}


# ============================================================
# RECORD ENTRY
# ============================================================

@app.post(
    "/attendance/entry"
)
def attendance_entry(
    attendance: AttendanceEventCreate
):

    employee = get_employee(
        attendance.employee_id
    )

    if employee is None:

        raise HTTPException(
            status_code=404,
            detail="Employee not found"
        )

    success = record_entry(
        attendance.employee_id
    )

    if not success:

        return {

            "message":
                "Entry was not recorded",

            "employee_id":
                attendance.employee_id,

            "status":
                "IGNORED"
        }

    summary = get_daily_summary(
        attendance.employee_id
    )

    return {

        "message":
            "Entry recorded successfully",

        "employee_id":
            attendance.employee_id,

        "event_type":
            "IN",

        "camera":
            camera_source_details("ENTRY"),

        "summary":
            summary
    }


# ============================================================
# RECORD EXIT
# ============================================================

@app.post(
    "/attendance/exit"
)
def attendance_exit(
    attendance: AttendanceEventCreate
):

    employee = get_employee(
        attendance.employee_id
    )

    if employee is None:

        raise HTTPException(
            status_code=404,
            detail="Employee not found"
        )

    success = record_exit(
        attendance.employee_id
    )

    if not success:

        return {

            "message":
                "Exit was not recorded",

            "employee_id":
                attendance.employee_id,

            "status":
                "IGNORED"
        }

    summary = get_daily_summary(
        attendance.employee_id
    )

    return {

        "message":
            "Exit recorded successfully",

        "employee_id":
            attendance.employee_id,

        "event_type":
            "OUT",

        "camera":
            camera_source_details("EXIT"),

        "summary":
            summary
    }


# ============================================================
# TODAY ATTENDANCE
# ============================================================

@app.get(
    "/attendance/today"
)
def today_attendance(current_user = Depends(get_current_user_optional)):
    dept = None
    if current_user and current_user["role"] == "hr":
        dept = current_user["department"]
    return get_today_attendance(department=dept)


# ============================================================
# HISTORICAL ATTENDANCE
# ============================================================

@app.get(
    "/attendance/date/{attendance_date}"
)
def attendance_by_date(
    attendance_date: str,
    current_user = Depends(get_current_user_optional),
):

    # --------------------------------------------------------
    # VALIDATE DATE
    # --------------------------------------------------------

    try:

        datetime.strptime(
            attendance_date,
            "%Y-%m-%d"
        )

    except ValueError:

        raise HTTPException(
            status_code=400,
            detail=(
                "Invalid date format. "
                "Use YYYY-MM-DD."
            )
        )

    # --------------------------------------------------------
    # GET ATTENDANCE
    # --------------------------------------------------------

    dept = None
    if current_user and current_user["role"] == "hr":
        dept = current_user["department"]

    try:

        result = get_attendance_by_date(
            attendance_date,
            department=dept
        )

    except ValueError as error:

        raise HTTPException(
            status_code=400,
            detail=str(error)
        )

    return result


# ============================================================
# DELETE ATTENDANCE FOR A PARTICULAR DATE
# ============================================================

@app.delete(
    "/attendance/date/{attendance_date}"
)
def remove_attendance_date(
    attendance_date: str
):

    """
    Delete attendance for a specific date.

    Deletes:
        - attendance_events
        - daily_attendance

    Keeps:
        - employees
        - face embeddings
        - employee face enrollment
    """

    # --------------------------------------------------------
    # VALIDATE DATE
    # --------------------------------------------------------

    try:

        datetime.strptime(
            attendance_date,
            "%Y-%m-%d"
        )

    except ValueError:

        raise HTTPException(
            status_code=400,
            detail=(
                "Invalid date format. "
                "Use YYYY-MM-DD."
            )
        )

    # --------------------------------------------------------
    # DELETE ATTENDANCE
    # --------------------------------------------------------

    try:

        result = delete_attendance_by_date(
            attendance_date
        )

    except ValueError as error:

        raise HTTPException(
            status_code=400,
            detail=str(error)
        )

    # --------------------------------------------------------
    # RESPONSE
    # --------------------------------------------------------

    return {

        "message":
            "Attendance deleted successfully",

        "date":
            attendance_date,

        "events_deleted":
            result["events_deleted"],

        "summaries_deleted":
            result["summaries_deleted"],

        "leaves_deleted":
            result["leaves_deleted"]
    }


# ============================================================
# MONTHLY ATTENDANCE HISTORY AND LEAVE
# ============================================================

@app.get("/employees/{employee_id}/attendance-history")
def employee_attendance_history(
    employee_id: str,
    year: int,
    month: int,
    current_user = Depends(get_current_user_optional),
):
    if month < 1 or month > 12:
        raise HTTPException(status_code=400, detail="month must be between 1 and 12")
    if year < 2000 or year > 2100:
        raise HTTPException(status_code=400, detail="year must be between 2000 and 2100")

    emp = get_employee(employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")

    emp = dict(emp)
    if current_user and current_user["role"] == "hr":
        if (emp.get("department") or "").lower() != (current_user.get("department") or "").lower():
            raise HTTPException(status_code=403, detail="Unauthorized: Access restricted to assigned department.")

    try:
        history = get_employee_attendance_history(employee_id, year, month)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if history is None:
        raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")
    return {
        "success": True,
        "employee_id": employee_id,
        "year": year,
        "month": month,
        "attendance": history["attendance"],
    }


def _validate_leave_date(value):
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except (TypeError, ValueError) as error:
        raise HTTPException(
            status_code=400,
            detail="leave_date must use YYYY-MM-DD format",
        ) from error


@app.post("/employees/{employee_id}/leave")
def create_employee_leave(
    employee_id: str,
    leave: LeaveCreate,
    current_user = Depends(get_current_user_optional),
):
    emp = get_employee(employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail="Employee not found")

    emp = dict(emp)
    if current_user and current_user["role"] == "hr":
        if (emp.get("department") or "").lower() != (current_user.get("department") or "").lower():
            raise HTTPException(status_code=403, detail="Unauthorized: Access restricted to assigned department.")

    if leave.employee_id.strip() != employee_id.strip():
        raise HTTPException(
            status_code=400,
            detail="employee_id in request body does not match URL",
        )
    _validate_leave_date(leave.leave_date)
    try:
        result = add_leave(
            employee_id,
            leave.leave_date,
            leave.leave_type,
            leave.reason,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if result is False:
        raise HTTPException(status_code=404, detail="Employee not found")

    if current_user:
        create_audit_log(
            actor_username=current_user["username"],
            actor_role=current_user["role"],
            action_type="LEAVE_RECORD",
            target_employee_id=employee_id,
            target_date=leave.leave_date,
            details=f"Added {leave.leave_type} on {leave.leave_date}: {leave.reason or 'No reason provided'}"
        )

    return {"success": True, "message": "Leave saved successfully", "data": result}


@app.get("/employees/{employee_id}/leave/{leave_date}")
def employee_leave(
    employee_id: str,
    leave_date: str,
    current_user = Depends(get_current_user_optional),
):
    emp = get_employee(employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    emp = dict(emp)
    if current_user and current_user["role"] == "hr":
        if (emp.get("department") or "").lower() != (current_user.get("department") or "").lower():
            raise HTTPException(status_code=403, detail="Unauthorized: Access restricted to assigned department.")
    _validate_leave_date(leave_date)
    return {"success": True, "data": get_leave(employee_id, leave_date)}


@app.delete("/employees/{employee_id}/leave/{leave_date}")
def remove_employee_leave(
    employee_id: str,
    leave_date: str,
    current_user = Depends(get_current_user_optional),
):
    emp = get_employee(employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    emp = dict(emp)
    if current_user and current_user["role"] == "hr":
        if (emp.get("department") or "").lower() != (current_user.get("department") or "").lower():
            raise HTTPException(status_code=403, detail="Unauthorized: Access restricted to assigned department.")
    _validate_leave_date(leave_date)
    deleted = delete_leave(employee_id, leave_date)

    if current_user and deleted:
        create_audit_log(
            actor_username=current_user["username"],
            actor_role=current_user["role"],
            action_type="LEAVE_DELETE",
            target_employee_id=employee_id,
            target_date=leave_date,
            details=f"Removed leave record on {leave_date}"
        )

    return {
        "success": True,
        "message": "Leave deleted" if deleted else "No leave record existed",
        "data": deleted,
    }


# ============================================================
# EXCEL REPORTS (DAY, WEEK, MONTH, CUSTOM)
# ============================================================

def _report_response(content, filename):
    return StreamingResponse(
        iter([content]),
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/reports/employee/{employee_id}")
def download_employee_report(
    employee_id: str,
    period: str = "monthly",
    date: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    current_user = Depends(get_current_user_optional),
):
    normalized_period = period.strip().lower()
    valid_periods = {"day", "daily", "week", "weekly", "month", "monthly", "custom"}
    if normalized_period not in valid_periods:
        raise HTTPException(
            status_code=400,
            detail="period must be one of: day, week, month, custom"
        )

    emp = get_employee(employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")

    emp = dict(emp)
    if current_user and current_user["role"] == "hr":
        if (emp.get("department") or "").lower() != (current_user.get("department") or "").lower():
            raise HTTPException(status_code=403, detail="Unauthorized: Access restricted to assigned department.")

    try:
        content, filename = create_employee_report(
            employee_id,
            normalized_period,
            date=date,
            start_date=start_date,
            end_date=end_date,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return _report_response(content, filename)


@app.get("/reports/attendance")
def download_all_employees_report(
    period: str = "monthly",
    date: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    department: str | None = None,
    current_user = Depends(get_current_user_optional),
):
    normalized_period = period.strip().lower()
    valid_periods = {"day", "daily", "week", "weekly", "month", "monthly", "custom"}
    if normalized_period not in valid_periods:
        raise HTTPException(
            status_code=400,
            detail="period must be one of: day, week, month, custom"
        )

    target_department = department
    if current_user and current_user["role"] == "hr":
        user_dept = (current_user["department"] or "").strip()
        if department and department.upper() != "ALL" and department.lower() != user_dept.lower():
            raise HTTPException(
                status_code=403,
                detail=f"Unauthorized: HR report access is restricted to department '{user_dept}'."
            )
        target_department = user_dept

    try:
        content, filename = create_all_employees_report(
            normalized_period,
            date=date,
            start_date=start_date,
            end_date=end_date,
            department=target_department,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return _report_response(content, filename)


# ============================================================
# EMPLOYEE DAILY SUMMARY
# ============================================================

@app.get(
    "/attendance/{employee_id}/summary"
)
def employee_daily_summary(
    employee_id: str
):

    employee = get_employee(
        employee_id
    )

    if employee is None:

        raise HTTPException(
            status_code=404,
            detail="Employee not found"
        )

    summary = get_daily_summary(
        employee_id
    )

    return summary


# ============================================================
# EMPLOYEE EVENTS
# ============================================================

@app.get(
    "/attendance/{employee_id}/events"
)
def employee_events(
    employee_id: str,
    attendance_date: str | None = None
):

    employee = get_employee(
        employee_id
    )

    if employee is None:

        raise HTTPException(
            status_code=404,
            detail="Employee not found"
        )

    # --------------------------------------------------------
    # VALIDATE DATE
    # --------------------------------------------------------

    if attendance_date is not None:

        try:

            datetime.strptime(
                attendance_date,
                "%Y-%m-%d"
            )

        except ValueError:

            raise HTTPException(
                status_code=400,
                detail=(
                    "attendance_date must use "
                    "YYYY-MM-DD format"
                )
            )

    events = get_employee_events(
        employee_id,
        attendance_date
    )

    return [
        dict(event)
        for event in events
    ]


# ============================================================
# EMPLOYEE ATTENDANCE
# ============================================================

@app.get(
    "/attendance/{employee_id}"
)
def employee_attendance(
    employee_id: str
):

    employee = get_employee(
        employee_id
    )

    if employee is None:

        raise HTTPException(
            status_code=404,
            detail="Employee not found"
        )

    events = get_employee_events(
        employee_id
    )

    return [
        dict(event)
        for event in events
    ]


# ============================================================
# ALL ATTENDANCE EVENTS
# ============================================================

@app.get(
    "/attendance"
)
def all_attendance():

    connection = get_connection()

    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            attendance_events.id,
            attendance_events.employee_id,
            employees.employee_name,
            employees.shift_start,
            employees.shift_end,
            attendance_events.event_date,
            attendance_events.event_time,
            attendance_events.event_type,
            attendance_events.created_at
        FROM attendance_events
        LEFT JOIN employees
        ON attendance_events.employee_id =
           employees.employee_id
        ORDER BY
            attendance_events.event_date DESC,
            attendance_events.event_time DESC,
            attendance_events.id DESC
    """)

    records = cursor.fetchall()

    connection.close()

    return [
        dict(record)
        for record in records
    ]


# ============================================================
# LIVE HEAD-POSE CHECK (used by guided face enrollment)
# ============================================================

def detect_faces_with_pose(image, max_faces=5):

    """
    Fast face + head-pose detection for the live enrollment guide.

    face_app.get() also runs the recognition (embedding) and
    gender/age models on every face, which is slow and not needed
    here. This runs only:

        1. the face detector
        2. the 3D-68 landmark model (gives pose + landmarks)

    Falls back to face_app.get() if the internals are not
    available in the installed insightface version.
    """

    try:

        bboxes, kpss = face_app.det_model.detect(
            image,
            max_num=0,
            metric="default"
        )

        if bboxes is None or bboxes.shape[0] == 0:
            return []

        areas = (
            (bboxes[:, 2] - bboxes[:, 0]) *
            (bboxes[:, 3] - bboxes[:, 1])
        )

        order = np.argsort(-areas)[:max_faces]

        landmark_model = face_app.models.get("landmark_3d_68")

        faces = []

        for index in order:

            face = Face(
                bbox=bboxes[index, 0:4],
                kps=kpss[index] if kpss is not None else None,
                det_score=bboxes[index, 4]
            )

            if landmark_model is not None:
                landmark_model.get(image, face)

            faces.append(face)

        return faces

    except Exception as error:

        print("Fast pose path failed, using face_app.get:", error)

        return list(face_app.get(image))


def landmark_cues(face):

    """
    Direction cues from the 68 landmarks.

    These do NOT depend on InsightFace's pose sign convention:

        yaw_cue   > 0 : nose is towards the RIGHT of the image
                        (= the person turned to THEIR left)
        pitch_cue smaller : chin is UP, bigger : chin is DOWN

    Used only to decide the direction (sign). The angle size
    still comes from the InsightFace pose.
    """

    landmarks = getattr(face, "landmark_3d_68", None)

    if landmarks is None:
        return None, None

    points = np.asarray(landmarks)[:, :2]

    jaw_width = max(abs(points[16, 0] - points[0, 0]), 1.0)

    yaw_cue = (
        points[30, 0] -
        (points[0, 0] + points[16, 0]) / 2.0
    ) / jaw_width

    face_height = max(points[8, 1] - points[27, 1], 1.0)

    pitch_cue = (
        points[30, 1] - points[27, 1]
    ) / face_height

    return float(yaw_cue), float(pitch_cue)


@app.post("/face-pose")
async def face_pose(
    file: UploadFile = File(...)
):

    """
    Take ONE small camera frame and report EVERY face in it
    (largest first) with its box, head pose and direction cues.

    The dashboard decides which face is the employee (the one
    inside the on-screen circle) and ignores everybody else.

    Nothing is saved.
    """

    data = await file.read()

    if not data:
        raise HTTPException(
            status_code=400,
            detail="Empty image."
        )

    image = cv2.imdecode(
        np.frombuffer(data, dtype=np.uint8),
        cv2.IMREAD_COLOR
    )

    if image is None:
        raise HTTPException(
            status_code=400,
            detail="Invalid image."
        )

    height, width = image.shape[:2]

    faces = await run_in_threadpool(
        detect_faces_with_pose,
        image
    )

    results = []

    for face in faces:

        x1, y1, x2, y2 = [float(v) for v in face.bbox]

        item = {
            "bbox": {
                "x1": max(0.0, x1 / width),
                "y1": max(0.0, y1 / height),
                "x2": min(1.0, x2 / width),
                "y2": min(1.0, y2 / height),
            },
            "det_score": float(face.det_score),
            "pose": None,
            "yaw_cue": None,
            "pitch_cue": None,
        }

        pose = getattr(face, "pose", None)

        if pose is not None:

            # InsightFace order is [pitch, yaw, roll]
            item["pose"] = {
                "pitch": float(pose[0]),
                "yaw": float(pose[1]),
                "roll": float(pose[2]),
            }

            yaw_cue, pitch_cue = landmark_cues(face)

            item["yaw_cue"] = yaw_cue
            item["pitch_cue"] = pitch_cue

        results.append(item)

    return {
        "face_count": len(results),
        "faces": results,
    }


# ============================================================
# MULTI-PHOTO FACE ENROLLMENT
# ============================================================

@app.post(
    "/employees/{employee_id}/enroll-face"
)
async def enroll_face(
    employee_id: str,
    files: list[UploadFile] = File(...)
):

    """
    Enroll multiple face images.

    Maximum:
        10 images

    Each image must contain:
        exactly one face.

    Keep one normalized embedding template per valid pose. Recognition groups
    these rows by employee and compares a live face against every template.
    """

    # --------------------------------------------------------
    # CHECK EMPLOYEE
    # --------------------------------------------------------

    employee = get_employee(
        employee_id
    )

    if employee is None:

        raise HTTPException(
            status_code=404,
            detail="Employee not found"
        )

    # --------------------------------------------------------
    # CHECK FILE COUNT
    # --------------------------------------------------------

    if not files:

        raise HTTPException(
            status_code=400,
            detail=(
                "Please provide at least "
                "one face image."
            )
        )

    if len(files) > 10:

        raise HTTPException(
            status_code=400,
            detail=(
                "Maximum 10 face images "
                "can be uploaded at once."
            )
        )

    # --------------------------------------------------------
    # PROCESS IMAGES
    # --------------------------------------------------------

    embeddings = []

    processed_files = []

    rejected_files = []

    for file in files:

        # ----------------------------------------------------
        # VALIDATE FILE TYPE
        # ----------------------------------------------------

        if not file.content_type:

            rejected_files.append({

                "filename":
                    file.filename,

                "reason":
                    "File type could not be determined."
            })

            continue

        if not file.content_type.startswith(
            "image/"
        ):

            rejected_files.append({

                "filename":
                    file.filename,

                "reason":
                    "File is not an image."
            })

            continue

        # ----------------------------------------------------
        # READ IMAGE
        # ----------------------------------------------------

        image_bytes = await file.read()

        if not image_bytes:

            rejected_files.append({

                "filename":
                    file.filename,

                "reason":
                    "Empty image."
            })

            continue

        image_array = np.frombuffer(
            image_bytes,
            dtype=np.uint8
        )

        image = cv2.imdecode(
            image_array,
            cv2.IMREAD_COLOR
        )

        if image is None:

            rejected_files.append({

                "filename":
                    file.filename,

                "reason":
                    "Invalid image."
            })

            continue

        # ----------------------------------------------------
        # FACE DETECTION
        # ----------------------------------------------------

        faces = face_app.get(
            image
        )

        if len(faces) == 0:

            rejected_files.append({

                "filename":
                    file.filename,

                "reason":
                    "No face detected."
            })

            continue

        if len(faces) > 1:

            rejected_files.append({

                "filename":
                    file.filename,

                "reason": (
                    "Multiple faces detected. "
                    "Use an image containing "
                    "only the employee."
                )
            })

            continue

        # ----------------------------------------------------
        # GET EMBEDDING
        # ----------------------------------------------------

        embedding = (
            faces[0].normed_embedding
        )

        if embedding is None:

            rejected_files.append({

                "filename":
                    file.filename,

                "reason":
                    "Could not generate face embedding."
            })

            continue

        embedding = np.asarray(
            embedding,
            dtype=np.float32
        ).reshape(-1)

        if embedding.shape[0] != 512:
            rejected_files.append({
                "filename": file.filename,
                "reason": f"Unexpected embedding dimension: {embedding.shape[0]}",
            })
            continue

        embeddings.append(embedding)
        processed_files.append(file.filename)
    # --------------------------------------------------------
    # REQUIRE VALID PHOTO
    # --------------------------------------------------------

    if len(embeddings) == 0:

        raise HTTPException(

            status_code=400,

            detail={

                "message":
                    "No valid face images were processed.",

                "processed_files":
                    [],

                "rejected_files":
                    rejected_files
            }
        )

    embeddings_array = np.asarray(embeddings, dtype=np.float32)
    norms = np.linalg.norm(embeddings_array, axis=1, keepdims=True)
    valid_embeddings = np.isfinite(norms[:, 0]) & (norms[:, 0] > 0)
    embeddings_array = embeddings_array[valid_embeddings]
    norms = norms[valid_embeddings]
    if embeddings_array.size == 0:
        raise HTTPException(
            status_code=500,
            detail="Generated embeddings have zero magnitude.",
        )
    pose_templates = (embeddings_array / norms).astype(np.float32)

    # --------------------------------------------------------
    # CREATE EMBEDDING DIRECTORY
    # --------------------------------------------------------

    embeddings_directory = os.path.dirname(
        EMBEDDINGS_FILE
    )

    os.makedirs(
        embeddings_directory,
        exist_ok=True
    )

    # --------------------------------------------------------
    # LOAD EXISTING EMBEDDINGS
    # --------------------------------------------------------

    employee_embeddings = {}

    if os.path.exists(
        EMBEDDINGS_FILE
    ):

        try:

            with open(
                EMBEDDINGS_FILE,
                "rb"
            ) as file_object:

                loaded_embeddings = pickle.load(
                    file_object
                )

            if isinstance(
                loaded_embeddings,
                dict
            ):

                employee_embeddings = (
                    loaded_embeddings
                )

        except (
            pickle.PickleError,
            EOFError,
            ValueError,
            TypeError
        ):

            employee_embeddings = {}

    # --------------------------------------------------------
    # SAVE FINAL EMBEDDING
    # --------------------------------------------------------

    employee_embeddings[
        employee_id
    ] = pose_templates

    with open(
        EMBEDDINGS_FILE,
        "wb"
    ) as file_object:

        pickle.dump(
            employee_embeddings,
            file_object
        )

    # --------------------------------------------------------
    # CREATE FACE DIRECTORY
    # --------------------------------------------------------

    employee_face_directory = os.path.join(
        FACES_DIRECTORY,
        employee_id
    )

    os.makedirs(
        employee_face_directory,
        exist_ok=True
    )

    # --------------------------------------------------------
    # RESPONSE
    # --------------------------------------------------------

    return {

        "message":
            "Face enrollment completed successfully",

        "employee_id":
            employee_id,

        "employee_name":
            employee["employee_name"],

        "photos_received":
            len(files),

        "photos_processed":
            len(processed_files),

        "photos_rejected":
            len(rejected_files),

        "embedding_dimension":
            int(
                pose_templates.shape[1]
            ),

        "embedding_templates":
            int(pose_templates.shape[0]),

        "embedding_file":
            EMBEDDINGS_FILE,

        "processed_files":
            processed_files,

        "rejected_files":
            rejected_files
    }