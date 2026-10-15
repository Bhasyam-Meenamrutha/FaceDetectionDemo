import os
import sys
import unittest
from datetime import date, datetime
import openpyxl
import io
from fastapi.testclient import TestClient

# Ensure Project_R is on python path
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from api import app
import attendance as db

client = TestClient(app)

class TestFaceAttendEnhancements(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Ensure DB is initialized
        db.create_database()

    def test_01_authentication_and_roles(self):
        # 1. Superior Login
        resp = client.post("/auth/login", json={"username": "superior", "password": "superior123"})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["role"], "superior")
        self.assertIn("token", data)
        superior_token = data["token"]

        # 2. Admin Login
        resp = client.post("/auth/login", json={"username": "admin", "password": "admin123"})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["role"], "admin")
        self.assertIn("token", data)

        # 3. HR Login with department match
        resp = client.post("/auth/login", json={"username": "hr", "password": "hr123", "department": "Software Services"})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["role"], "hr")
        self.assertEqual(data["department"], "Software Services")

        # 4. HR Login with mismatched department fails
        resp = client.post("/auth/login", json={"username": "hr", "password": "hr123", "department": "MAPPS"})
        self.assertEqual(resp.status_code, 403)

        # 5. Invalid credentials fail
        resp = client.post("/auth/login", json={"username": "superior", "password": "wrongpassword"})
        self.assertEqual(resp.status_code, 401)

    def test_02_superior_provision_admin_and_forced_password_change(self):
        # Superior login
        sup_login = client.post("/auth/login", json={"username": "superior", "password": "superior123"}).json()
        sup_headers = {"Authorization": f"Bearer {sup_login['token']}"}

        # Superior creates new Admin
        test_admin_user = f"admintest_{int(datetime.now().timestamp())}"
        create_resp = client.post("/admin/create-admin", json={
            "username": test_admin_user,
            "password": "initialPass123"
        }, headers={**sup_headers, "X-Client-Role": "superior", "X-Client-User": "superior"})
        self.assertEqual(create_resp.status_code, 200)

        # New admin logs in -> must_change_password should be True
        admin_login = client.post("/auth/login", json={"username": test_admin_user, "password": "initialPass123"}).json()
        self.assertTrue(admin_login.get("must_change_password"))
        admin_token = admin_login["token"]
        admin_headers = {"Authorization": f"Bearer {admin_token}"}

        # Admin changes password
        change_resp = client.post("/auth/change-password", json={
            "current_password": "initialPass123",
            "new_password": "newSecurePass123"
        }, headers=admin_headers)
        self.assertEqual(change_resp.status_code, 200)

        # Admin logs in again with new password -> must_change_password should now be False
        admin_login_after = client.post("/auth/login", json={"username": test_admin_user, "password": "newSecurePass123"}).json()
        self.assertFalse(admin_login_after.get("must_change_password"))

    def test_03_admin_general_access_provision_hr_and_dept_isolation(self):
        # Admin login
        admin_login = client.post("/auth/login", json={"username": "admin", "password": "admin123"}).json()
        admin_headers = {"Authorization": f"Bearer {admin_login['token']}", "X-Client-Role": "admin", "X-Client-User": "admin"}

        # Admin provisions HR for DAAPS department
        test_hr_user = f"hr_daaps_{int(datetime.now().timestamp())}"
        create_resp = client.post("/admin/create-hr", json={
            "username": test_hr_user,
            "password": "hrPassword123",
            "department": "DAAPS"
        }, headers=admin_headers)
        self.assertEqual(create_resp.status_code, 200)

        # Log in as newly created HR
        hr_login = client.post("/auth/login", json={"username": test_hr_user, "password": "hrPassword123", "department": "DAAPS"}).json()
        self.assertEqual(hr_login["role"], "hr")
        self.assertEqual(hr_login["department"], "DAAPS")
        hr_headers = {"Authorization": f"Bearer {hr_login['token']}", "X-Client-Role": "hr", "X-Client-Department": "DAAPS"}

        # HR can view employees for DAAPS
        emp_resp = client.get("/employees", headers=hr_headers)
        self.assertEqual(emp_resp.status_code, 200)
        for emp in emp_resp.json():
            self.assertEqual(emp.get("department"), "DAAPS")

        # HR cannot access/query another department's employee attendance or delete them
        # Let's get an employee from another dept (e.g. Software Services)
        all_emps = client.get("/employees", headers={"X-Client-Role": "superior"}).json()
        other_dept_emp = next((e for e in all_emps if e.get("department") != "DAAPS"), None)
        if other_dept_emp:
            # HR cannot edit shift of employee from other dept
            shift_resp = client.put(f"/employees/{other_dept_emp['employee_id']}/shift", json={"shift_start": "09:00", "shift_end": "17:00"}, headers=hr_headers)
            self.assertEqual(shift_resp.status_code, 403)
            # HR cannot delete employee from other dept
            del_resp = client.delete(f"/employees/{other_dept_emp['employee_id']}", headers=hr_headers)
            self.assertEqual(del_resp.status_code, 403)

    def test_04_attendance_calculation_rules(self):
        # Verify 4h and 7.5h threshold rules
        self.assertEqual(db.calculate_attendance_status(0), "ABSENT")
        self.assertEqual(db.calculate_attendance_status(180), "ABSENT")       # 3 hours < 4h
        self.assertEqual(db.calculate_attendance_status(239), "ABSENT")       # 3h 59m < 4h
        self.assertEqual(db.calculate_attendance_status(240), "HALF_DAY")     # Exactly 4 hours
        self.assertEqual(db.calculate_attendance_status(400), "HALF_DAY")     # 6h 40m
        self.assertEqual(db.calculate_attendance_status(450), "HALF_DAY")     # Exactly 7.5 hours (450 minutes)
        self.assertEqual(db.calculate_attendance_status(451), "FULL_DAY")     # > 7.5 hours
        self.assertEqual(db.calculate_attendance_status(480), "FULL_DAY")     # 8 hours

    def test_05_superior_manual_attendance_correction_and_audit_log(self):
        # Superior performs manual attendance correction
        sup_login = client.post("/auth/login", json={"username": "superior", "password": "superior123"}).json()
        sup_headers = {"Authorization": f"Bearer {sup_login['token']}", "X-Client-Role": "superior", "X-Client-User": "superior"}

        # Get an employee
        all_emps = client.get("/employees", headers=sup_headers).json()
        self.assertTrue(len(all_emps) > 0)
        target_emp = all_emps[0]

        target_date = "2026-10-10"
        override_resp = client.post("/attendance/manual-correction", json={
            "employee_id": target_emp["employee_id"],
            "date": target_date,
            "status": "FULL_DAY",
            "worked_hours": 8.0,
            "reason": "Official client on-site visit approval"
        }, headers=sup_headers)
        self.assertEqual(override_resp.status_code, 200)

        # Verify audit log recorded the action
        audit_resp = client.get("/audit/logs", headers=sup_headers)
        self.assertEqual(audit_resp.status_code, 200)
        logs = audit_resp.json()
        found = any(
            (l.get("action_type") == "MANUAL_ATTENDANCE_CORRECTION" or l.get("action") == "MANUAL_ATTENDANCE_CORRECTION") and
            target_emp["employee_id"] in (l.get("target_id") or l.get("details") or "") and
            "Official client on-site visit approval" in (l.get("reason") or "")
            for l in logs
        )
        self.assertTrue(found, "Manual correction audit log entry not found")

    def test_06_flexible_shift_configuration(self):
        sup_login = client.post("/auth/login", json={"username": "superior", "password": "superior123"}).json()
        sup_headers = {"Authorization": f"Bearer {sup_login['token']}", "X-Client-Role": "superior", "X-Client-User": "superior"}

        all_emps = client.get("/employees", headers=sup_headers).json()
        target_emp = all_emps[0]

        # Enable flexible shift
        resp = client.put(f"/employees/{target_emp['employee_id']}/shift", json={
            "shift_start": "09:00",
            "shift_end": "17:00",
            "is_flexible_shift": True
        }, headers=sup_headers)
        self.assertEqual(resp.status_code, 200)

        # Check employee record reflects flexible shift
        emp_check = client.get("/employees", headers=sup_headers).json()
        updated_emp = next(e for e in emp_check if e["employee_id"] == target_emp["employee_id"])
        self.assertTrue(bool(updated_emp.get("is_flexible_shift")))

    def test_07_attendance_exports_day_week_month_custom(self):
        sup_login = client.post("/auth/login", json={"username": "superior", "password": "superior123"}).json()
        sup_headers = {"Authorization": f"Bearer {sup_login['token']}", "X-Client-Role": "superior", "X-Client-User": "superior"}

        all_emps = client.get("/employees", headers=sup_headers).json()
        target_emp = all_emps[0]

        # 1. Day export
        resp_day = client.get(f"/reports/attendance?period=day&date=2026-10-10", headers=sup_headers)
        self.assertEqual(resp_day.status_code, 200)
        self.assertEqual(resp_day.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        wb = openpyxl.load_workbook(io.BytesIO(resp_day.content))
        self.assertIn("Attendance Summary", wb.sheetnames)
        headers = [cell.value for cell in wb["Attendance Summary"][1]]
        self.assertIn("Break Duration", headers)

        # 2. Week export
        resp_week = client.get(f"/reports/attendance?period=week&date=2026-10-10", headers=sup_headers)
        self.assertEqual(resp_week.status_code, 200)

        # 3. Month export
        resp_month = client.get(f"/reports/attendance?period=month&date=2026-10-10", headers=sup_headers)
        self.assertEqual(resp_month.status_code, 200)

        # 4. Custom range export
        resp_custom = client.get(f"/reports/attendance?period=custom&start_date=2026-10-01&end_date=2026-10-15", headers=sup_headers)
        self.assertEqual(resp_custom.status_code, 200)

        # 5. Single employee custom export
        resp_emp_custom = client.get(f"/reports/employee/{target_emp['employee_id']}?period=custom&start_date=2026-10-01&end_date=2026-10-15", headers=sup_headers)
        self.assertEqual(resp_emp_custom.status_code, 200)

    def test_08_dynamic_departments_endpoint(self):
        resp = client.get("/departments")
        self.assertEqual(resp.status_code, 200)
        depts = resp.json()
        self.assertIn("Innovation", depts)
        self.assertIn("Software Training", depts)
        self.assertIn("MAPPS", depts)
        self.assertIn("DAAPS", depts)

if __name__ == "__main__":
    unittest.main()
