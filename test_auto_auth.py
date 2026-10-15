import unittest
import os
import json
from fastapi.testclient import TestClient
from api import app
import attendance as db

client = TestClient(app)

class TestAutoRoleAuthentication(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.create_database()

    def test_01_superior_auto_role_login(self):
        # User supplies ONLY username and password
        resp = client.post("/auth/login", json={"username": "superior", "password": "superior123"})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["ok"], True)
        self.assertEqual(data["role"], "superior")
        self.assertEqual(data["department"], "ALL")
        self.assertIn("token", data)

        # Test superior access
        headers = {"Authorization": f"Bearer {data['token']}"}
        audit_resp = client.get("/audit/logs", headers=headers)
        self.assertEqual(audit_resp.status_code, 200)

    def test_02_admin_auto_role_login(self):
        # User supplies ONLY username and password
        resp = client.post("/auth/login", json={"username": "admin", "password": "admin123"})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["ok"], True)
        self.assertEqual(data["role"], "admin")
        self.assertEqual(data["department"], "ALL")
        self.assertIn("token", data)

        # Test admin access: admin cannot access superior-only audit logs or admin creation
        headers = {"Authorization": f"Bearer {data['token']}"}
        audit_resp = client.get("/audit/logs", headers=headers)
        self.assertEqual(audit_resp.status_code, 403)

    def test_03_hr_auto_role_login_software_services(self):
        # User supplies ONLY username and password
        resp = client.post("/auth/login", json={"username": "hr", "password": "hr123"})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["ok"], True)
        self.assertEqual(data["role"], "hr")
        self.assertEqual(data["department"], "Software Services")
        self.assertIn("token", data)

        # Test HR access: cannot create HR or Admin accounts
        headers = {"Authorization": f"Bearer {data['token']}"}
        create_hr = client.post("/admin/create-hr", json={"department": "Innovation", "username": "hack_hr", "password": "pwd"}, headers=headers)
        self.assertEqual(create_hr.status_code, 403)

    def test_04_hr_auto_role_login_other_departments(self):
        # purnima -> Human Resources
        resp = client.post("/auth/login", json={"username": "purnima", "password": "hr123"})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["role"], "hr")
        self.assertEqual(data["department"], "Human Resources")

        # hr_innovation -> Innovation
        resp_inno = client.post("/auth/login", json={"username": "hr_innovation", "password": "hr123"})
        self.assertEqual(resp_inno.status_code, 200)
        self.assertEqual(resp_inno.json()["department"], "Innovation")

        # hr_training -> Software Training
        resp_train = client.post("/auth/login", json={"username": "hr_training", "password": "hr123"})
        self.assertEqual(resp_train.status_code, 200)
        self.assertEqual(resp_train.json()["department"], "Software Training")

    def test_05_invalid_credentials_and_validation(self):
        # Wrong password
        resp = client.post("/auth/login", json={"username": "superior", "password": "wrong_password"})
        self.assertEqual(resp.status_code, 401)

        # Non-existent user
        resp = client.post("/auth/login", json={"username": "unknown_user_999", "password": "password123"})
        self.assertEqual(resp.status_code, 401)

        # Missing username
        resp = client.post("/auth/login", json={"username": "", "password": "password123"})
        self.assertEqual(resp.status_code, 400)

        # Missing password
        resp = client.post("/auth/login", json={"username": "admin", "password": ""})
        self.assertEqual(resp.status_code, 400)

if __name__ == "__main__":
    unittest.main()
