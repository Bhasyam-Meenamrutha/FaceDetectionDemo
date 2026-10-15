import { useEffect, useMemo, useRef, useState } from "react";
import LoginPage from "./components/LoginPage";
import miracleLogo from "./assets/miracle-logo.svg";

const API_URL = "http://127.0.0.1:8000";
const HUBBLE_API_URL = "http://127.0.0.1:8001";

const formatEmployeeName = (name) => {
  if (!name) return "";
  return String(name)
    .split(" ")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : ""))
    .join(" ");
};

// ============================================================
// GUIDED FACE ENROLLMENT
// ------------------------------------------------------------
// The employee follows 9 head angles (like the reference sheet).
// A dotted oval is shown on the camera for every angle:
//   grey  = nobody inside the oval yet
//   red   = face is inside the oval but the angle is wrong
//   green = angle is right -> held briefly -> auto capture
//
// Only the face INSIDE the oval counts. Other people in the
// background are ignored, and are masked out of the saved photo.
//
// Angles are in degrees from the USER's point of view:
//   yaw   : negative = turn to your left,  positive = your right
//   pitch : positive = chin up,            negative = chin down
// ============================================================
const POSE_STEPS = [
  { id: "front",      label: "Front",       arrow: "●", yaw: 0,   pitch: 0,   row: 1, col: 1, hint: "Look straight at the camera" },
  { id: "left",       label: "Left 3/4",    arrow: "←", yaw: -30, pitch: 0,   row: 1, col: 0, hint: "Slowly turn your head to your left" },
  { id: "right",      label: "Right 3/4",   arrow: "→", yaw: 30,  pitch: 0,   row: 1, col: 2, hint: "Slowly turn your head to your right" },
  { id: "up",         label: "Up",          arrow: "↑", yaw: 0,   pitch: 15,  row: 0, col: 1, hint: "Lift your chin up a little" },
  { id: "up-left",    label: "Up + Left",   arrow: "↖", yaw: -28, pitch: 14,  row: 0, col: 0, hint: "Chin up and turn to your left" },
  { id: "up-right",   label: "Up + Right",  arrow: "↗", yaw: 28,  pitch: 14,  row: 0, col: 2, hint: "Chin up and turn to your right" },
  { id: "down",       label: "Down",        arrow: "↓", yaw: 0,   pitch: -15, row: 2, col: 1, hint: "Lower your chin a little" },
  { id: "down-left",  label: "Down + Left", arrow: "↙", yaw: -28, pitch: -14, row: 2, col: 0, hint: "Chin down and turn to your left" },
  { id: "down-right", label: "Down + Right",arrow: "↘", yaw: 28,  pitch: -14, row: 2, col: 2, hint: "Chin down and turn to your right" },
];

// ---- Tuning knobs -------------------------------------------
const OVAL_HEIGHT = 0.94;        // oval height / camera height (CSS uses the same 94%)
const OVAL_RATIO = 0.75;         // oval width / height (3:4)
const YAW_TOLERANCE = 12;        // degrees allowed around the target
const PITCH_TOLERANCE = 10;
const FRONT_YAW_LIMIT = 10;      // "front" is judged on raw angles
const FRONT_PITCH_LIMIT = 15;
const FRONT_YAW_CUE_LIMIT = 0.12;
const YAW_CUE_MIN = 0.04;        // min nose shift needed to trust a turn direction
const PITCH_CUE_MIN = 0.02;
const HOLD_FRAMES = 2;           // consecutive good frames before capture
const POLL_MS = 150;             // wait between frame checks
const CAPTURE_COOLDOWN_MS = 500; // pause after a capture
const MIN_FACE_RATIO = 0.40;     // face height / oval height (too far)
const MAX_FACE_RATIO = 1.0;      // (too close)
const MIN_DET_SCORE = 0.6;

const EMPTY_BASELINE = { yaw: 0, pitch: 0, yawCue: 0, pitchCue: 0 };

// Pick the face that is inside the oval (closest to its centre).
// Everybody else is "background" and is ignored.
function pickFaceInOval(faces, aspect) {
  const radiusY = OVAL_HEIGHT / 2;
  const radiusX = (OVAL_HEIGHT * OVAL_RATIO) / aspect / 2;

  let target = null;
  let best = Infinity;

  for (const face of faces) {
    const centerX = (face.bbox.x1 + face.bbox.x2) / 2;
    const centerY = (face.bbox.y1 + face.bbox.y2) / 2;

    const distance =
      ((centerX - 0.5) / radiusX) ** 2 + ((centerY - 0.5) / radiusY) ** 2;

    if (distance <= 1 && distance < best) {
      best = distance;
      target = face;
    }
  }

  return target;
}

// Decide whether the face in the oval is at the requested angle.
// Returns { ok, idle, message, target, yaw, pitch }.
function evaluatePose(step, data, baseline, aspect) {
  const faces = data?.faces || [];

  const target = pickFaceInOval(faces, aspect);

  if (!target) {
    return {
      ok: false,
      idle: true,
      target: null,
      message: "Put your face inside the circle.",
    };
  }

  if (target.det_score !== null && target.det_score < MIN_DET_SCORE) {
    return { ok: false, target, message: "Face is not clear. Improve the lighting." };
  }

  const faceRatio = (target.bbox.y2 - target.bbox.y1) / OVAL_HEIGHT;

  if (faceRatio < MIN_FACE_RATIO) {
    return { ok: false, target, message: "Move a little closer to the camera." };
  }

  if (faceRatio > MAX_FACE_RATIO) {
    return { ok: false, target, message: "Move back a little." };
  }

  if (!target.pose || target.yaw_cue === null || target.pitch_cue === null) {
    return { ok: false, idle: true, target, message: "Could not read head angle." };
  }

  const isFront = step.id === "front";

  // ---------- FRONT ----------
  if (isFront) {
    const yawOk =
      Math.abs(target.pose.yaw) <= FRONT_YAW_LIMIT &&
      Math.abs(target.yaw_cue) <= FRONT_YAW_CUE_LIMIT;

    const pitchOk = Math.abs(target.pose.pitch) <= FRONT_PITCH_LIMIT;

    if (yawOk && pitchOk) {
      return { ok: true, target, yaw: 0, pitch: 0, message: "Perfect. Hold still..." };
    }

    return {
      ok: false,
      target,
      yaw: 0,
      pitch: 0,
      message: !yawOk ? "Face the camera straight." : "Keep your head level.",
    };
  }

  // ---------- OTHER ANGLES ----------
  // Size comes from InsightFace (relative to the front photo).
  // DIRECTION comes from the landmark cues, so left can never be
  // mistaken for right whatever the sign convention is.
  const sizeYaw = Math.abs(target.pose.yaw - baseline.yaw);
  const sizePitch = Math.abs(target.pose.pitch - baseline.pitch);

  const dYawCue = target.yaw_cue - baseline.yawCue;
  const dPitchCue = target.pitch_cue - baseline.pitchCue;

  // nose moved to image-right => user turned to THEIR left (negative)
  let yaw = 0;
  if (Math.abs(dYawCue) >= YAW_CUE_MIN) {
    yaw = (dYawCue > 0 ? -1 : 1) * sizeYaw;
  }

  // nose closer to the eyes => chin up (positive)
  let pitch = 0;
  if (Math.abs(dPitchCue) >= PITCH_CUE_MIN) {
    pitch = (dPitchCue < 0 ? 1 : -1) * sizePitch;
  }

  const yawDiff = step.yaw - yaw;
  const pitchDiff = step.pitch - pitch;

  const yawOk = Math.abs(yawDiff) <= YAW_TOLERANCE;
  const pitchOk = Math.abs(pitchDiff) <= PITCH_TOLERANCE;

  if (yawOk && pitchOk) {
    return { ok: true, target, yaw, pitch, message: "Perfect. Hold still..." };
  }

  let message = step.hint;

  if (!yawOk) {
    const wrongWay = step.yaw !== 0 && yaw * step.yaw < 0 && Math.abs(yaw) > 8;
    const side = step.yaw !== 0 ? (step.yaw < 0 ? "left" : "right") : yawDiff < 0 ? "left" : "right";

    if (wrongWay) {
      message = `Wrong way. Turn to your ${side}.`;
    } else if (step.yaw === 0) {
      message = "Face straight, do not turn sideways.";
    } else if (Math.abs(yaw) > Math.abs(step.yaw)) {
      message = "Turn back a little.";
    } else {
      message = `Turn a bit more to your ${side}.`;
    }
  } else if (!pitchOk) {
    if (step.pitch === 0) {
      message = "Keep your head level.";
    } else if (pitchDiff > 0) {
      message = "Lift your chin a little more.";
    } else {
      message = "Lower your chin a little more.";
    }
  }

  return { ok: false, target, yaw, pitch, message };
}

function App() {
  const [auth, setAuth] = useState(() => {
    try {
      const saved = sessionStorage.getItem("faceattend_auth");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const authFetch = (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (auth?.token) {
      headers["Authorization"] = `Bearer ${auth.token}`;
    }
    return fetch(url, { ...options, headers });
  };

  const [deptFilter, setDeptFilter] = useState("ALL");
  const [locationFilter, setLocationFilter] = useState("ALL");
  const [dbDepartments, setDbDepartments] = useState([]);

  const handleLogout = () => {
    setAuth(null);
    try {
      sessionStorage.removeItem("faceattend_auth");
    } catch {}
  };

  // Password Change State (Forced and Manual)
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    old_password: "",
    new_password: "",
    confirm_password: "",
  });
  const [passwordStatus, setPasswordStatus] = useState({
    loading: false,
    error: "",
    success: "",
  });

  // Superior State: Admin Account Creation & Management
  const [adminList, setAdminList] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [newAdminForm, setNewAdminForm] = useState({
    username: "",
    password: "",
    display_name: "",
  });
  const [adminCreateStatus, setAdminCreateStatus] = useState({
    loading: false,
    error: "",
    success: "",
  });

  // Admin State: General Access (HR Credentials Creation)
  const [hrList, setHrList] = useState([]);
  const [hrLoading, setHrLoading] = useState(false);
  const [newHrForm, setNewHrForm] = useState({
    department: "Innovation",
    username: "",
    password: "",
    display_name: "",
  });
  const [hrCreateStatus, setHrCreateStatus] = useState({
    loading: false,
    error: "",
    success: "",
  });

  // Superior State: Audit & Activity Logs
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditRoleFilter, setAuditRoleFilter] = useState("ALL");
  const [auditActionFilter, setAuditActionFilter] = useState("ALL");
  const [auditDateFilter, setAuditDateFilter] = useState("");

  // Superior State: Manual Attendance Override
  const [overrideForm, setOverrideForm] = useState({
    employee_id: "",
    attendance_date: new Date().toISOString().slice(0, 10),
    status: "FULL_DAY",
    first_in: "09:00:00",
    last_out: "17:30:00",
    worked_minutes: 480,
    reason: "",
  });
  const [overrideStatus, setOverrideStatus] = useState({
    loading: false,
    error: "",
    success: "",
  });

  // Today's Attendance Details Modal (Employee View Action)
  const [dailyViewEmployee, setDailyViewEmployee] = useState(null);

  // Compact Employee Cards: Expanded Employee ID
  const [expandedEmployeeId, setExpandedEmployeeId] = useState(null);

  const [employees, setEmployees] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [cameraStatus, setCameraStatus] = useState(null);
  const [cameraDraft, setCameraDraft] = useState({
    id: null,
    name: "",
    source_type: "webcam",
    source: "0",
    roles: ["ENTRY"],
    enabled: true,
  });
  const [showCameraEditor, setShowCameraEditor] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraActionError, setCameraActionError] = useState("");
  const [cameraActionMessage, setCameraActionMessage] = useState("");
  const [viewCamera, setViewCamera] = useState(null);

  const [loading, setLoading] = useState(true);
  const [cameraLoading, setCameraLoading] = useState(true);
  const [error, setError] = useState("");
  const [cameraError, setCameraError] = useState("");

  const [activePage, setActivePage] = useState("dashboard");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  // Date used by the Attendance page.
  // Dashboard continues to use today's live attendance.
  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [dateAttendanceLoading, setDateAttendanceLoading] = useState(false);
  const [dateAttendanceError, setDateAttendanceError] = useState("");

  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [attendanceHistory, setAttendanceHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyYear, setHistoryYear] = useState(new Date().getFullYear());
  const [historyMonth, setHistoryMonth] = useState(new Date().getMonth() + 1);
  const [selectedHistoryDay, setSelectedHistoryDay] = useState(null);

  // Report Export State
  const [reportChooser, setReportChooser] = useState(null);
  const [reportPeriod, setReportPeriod] = useState("month");
  const [reportDate, setReportDate] = useState(new Date().toISOString().slice(0, 10));
  const [reportStartDate, setReportStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [reportEndDate, setReportEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [reportDownloading, setReportDownloading] = useState(false);
  const [reportError, setReportError] = useState("");

  const [showAddEmployee, setShowAddEmployee] = useState(false);
  const [employeeForm, setEmployeeForm] = useState({
    employee_id: "",
    employee_name: "",
    shift_start: "14:00",
    shift_end: "22:00",
    email: "",
    login_id: "",
    department: "",
    work_location: "Miracle City (HQ)",
    is_flexible_shift: false,
  });

  const [formMessage, setFormMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [deletingEmployeeId, setDeletingEmployeeId] = useState(null);
  const [hubbleLoading, setHubbleLoading] = useState(false);
  const [hubbleError, setHubbleError] = useState("");
  const [hubbleEmployee, setHubbleEmployee] = useState(null);
  const [editingEmployee, setEditingEmployee] = useState(null);
  const [editShiftForm, setEditShiftForm] = useState({
    shift_start: "09:00",
    shift_end: "17:00",
    is_flexible_shift: false,
  });
  const [editShiftLoading, setEditShiftLoading] = useState(false);
  const [editShiftError, setEditShiftError] = useState("");
  const [leaveSaving, setLeaveSaving] = useState(false);

  // Miracle UI States
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showProfileDropdown, setShowProfileDropdown] = useState(false);
  const [actionEmployee, setActionEmployee] = useState(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showTourModal, setShowTourModal] = useState(false);

  // Face enrollment / camera capture state.
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [cameraStream, setCameraStream] = useState(null);
  const [enrollmentCameraId, setEnrollmentCameraId] = useState("");
  const cameraImageRef = useRef(null);
  const [captureError, setCaptureError] = useState("");
  const [capturedPhotos, setCapturedPhotos] = useState([]);
  const [enrollmentLoading, setEnrollmentLoading] = useState(false);

  // Guided (auto) capture state.
  const [skippedSteps, setSkippedSteps] = useState([]);
  const [poseState, setPoseState] = useState({
    status: "idle", // idle (grey) | bad (red) | ok (green) | done (green flash)
    message: "Start the camera to begin.",
    debug: null,
  });
  const [showPoseDebug, setShowPoseDebug] = useState(false);
  const poseCanvasRef = useRef(null);
  const holdCountRef = useRef(0);
  const cooldownUntilRef = useRef(0);
  const baselineRef = useRef({ ...EMPTY_BASELINE });
  const [videoAspect, setVideoAspect] = useState(16 / 9);

  // The angle we are asking for right now (first one not captured/skipped).
  const currentStep = useMemo(
    () =>
      POSE_STEPS.find(
        (step) =>
          !capturedPhotos.some((photo) => photo.poseId === step.id) &&
          !skippedSteps.includes(step.id)
      ) || null,
    [capturedPhotos, skippedSteps]
  );

  const loadDashboardData = async () => {
    try {
      setError("");

      const [employeesResponse, attendanceResponse] = await Promise.all([
        authFetch(`${API_URL}/employees`),
        authFetch(`${API_URL}/attendance/today`),
      ]);

      if (!employeesResponse.ok) {
        throw new Error("Unable to load employees");
      }

      if (!attendanceResponse.ok) {
        throw new Error("Unable to load attendance");
      }

      const employeesData = await employeesResponse.json();
      const attendanceData = await attendanceResponse.json();

      setEmployees(Array.isArray(employeesData) ? employeesData : []);

      const attendanceList = Array.isArray(attendanceData)
        ? attendanceData
        : attendanceData?.attendance || attendanceData?.data || [];

      setAttendance(attendanceList);
    } catch (err) {
      setError(err.message || "Unable to connect to backend");
    } finally {
      setLoading(false);
    }
  };

  const loadAttendanceByDate = async (date) => {
    if (!date) return;

    try {
      setDateAttendanceLoading(true);
      setDateAttendanceError("");

      const response = await authFetch(
        `${API_URL}/attendance/date/${date}`
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          data.detail || "Unable to load attendance for selected date"
        );
      }

      const data = await response.json();

      const attendanceList = Array.isArray(data)
        ? data
        : data?.attendance || data?.data || [];

      setAttendance(attendanceList);

      if (employees.length === 0) {
        authFetch(`${API_URL}/employees`)
          .then((res) => res.json())
          .then((empData) => {
            if (Array.isArray(empData) && empData.length > 0) setEmployees(empData);
          })
          .catch(() => {});
      }
    } catch (err) {
      setDateAttendanceError(
        err.message || "Unable to load selected date"
      );
      setAttendance([]);
    } finally {
      setDateAttendanceLoading(false);
    }
  };

  // Password Update Handler
  const handlePasswordChange = async (event) => {
    event.preventDefault();
    setPasswordStatus({ loading: true, error: "", success: "" });

    if (!passwordForm.old_password) {
      setPasswordStatus({ loading: false, error: "Please enter your current password.", success: "" });
      return;
    }
    if (!passwordForm.new_password || passwordForm.new_password.length < 4) {
      setPasswordStatus({ loading: false, error: "New password must be at least 4 characters.", success: "" });
      return;
    }
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setPasswordStatus({ loading: false, error: "New password and confirm password do not match.", success: "" });
      return;
    }

    try {
      const response = await authFetch(`${API_URL}/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          old_password: passwordForm.old_password,
          new_password: passwordForm.new_password,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail || "Password change failed.");
      }

      setPasswordStatus({
        loading: false,
        error: "",
        success: "Password updated successfully. Session updated.",
      });

      const updatedAuth = { ...auth, must_change_password: false };
      setAuth(updatedAuth);
      try {
        sessionStorage.setItem("faceattend_auth", JSON.stringify(updatedAuth));
      } catch {}

      setTimeout(() => {
        setShowPasswordModal(false);
        setPasswordForm({ old_password: "", new_password: "", confirm_password: "" });
        setPasswordStatus({ loading: false, error: "", success: "" });
      }, 900);
    } catch (err) {
      setPasswordStatus({
        loading: false,
        error: err.message || "Unable to update password.",
        success: "",
      });
    }
  };

  // Superior: Load Admins
  const loadAdminUsers = async () => {
    try {
      setAdminLoading(true);
      const res = await authFetch(`${API_URL}/admin/users`);
      if (res.ok) {
        const data = await res.json();
        setAdminList(Array.isArray(data) ? data : []);
      }
    } catch {
      // ignore
    } finally {
      setAdminLoading(false);
    }
  };

  // Superior: Create Admin Account
  const handleCreateAdmin = async (event) => {
    event.preventDefault();
    setAdminCreateStatus({ loading: true, error: "", success: "" });

    if (!newAdminForm.username.trim()) {
      setAdminCreateStatus({ loading: false, error: "Username is required.", success: "" });
      return;
    }
    if (!newAdminForm.password || newAdminForm.password.length < 4) {
      setAdminCreateStatus({ loading: false, error: "Password must be at least 4 characters.", success: "" });
      return;
    }

    try {
      const res = await authFetch(`${API_URL}/admin/create-admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newAdminForm.username.trim(),
          password: newAdminForm.password,
          display_name: newAdminForm.display_name.trim() || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || "Failed to generate administrator credentials.");
      }

      setAdminCreateStatus({
        loading: false,
        error: "",
        success: "Admin credentials generated successfully. Admin must change password on first login.",
      });
      setNewAdminForm({ username: "", password: "", display_name: "" });
      loadAdminUsers();
    } catch (err) {
      setAdminCreateStatus({
        loading: false,
        error: err.message || "Unable to create administrator account.",
        success: "",
      });
    }
  };

  // Admin: Load HR accounts
  const loadHrUsers = async () => {
    try {
      setHrLoading(true);
      const res = await authFetch(`${API_URL}/admin/users`);
      if (res.ok) {
        const data = await res.json();
        const hrOnly = Array.isArray(data) ? data.filter((u) => u.role === "hr") : [];
        setHrList(hrOnly);
      }
    } catch {
      // ignore
    } finally {
      setHrLoading(false);
    }
  };

  // Admin: Create HR Credentials
  const handleCreateHr = async (event) => {
    event.preventDefault();
    setHrCreateStatus({ loading: true, error: "", success: "" });

    if (!newHrForm.department) {
      setHrCreateStatus({ loading: false, error: "Please select an authorized department.", success: "" });
      return;
    }
    if (!newHrForm.username.trim()) {
      setHrCreateStatus({ loading: false, error: "HR username is required.", success: "" });
      return;
    }
    if (!newHrForm.password || newHrForm.password.length < 4) {
      setHrCreateStatus({ loading: false, error: "Password must be at least 4 characters.", success: "" });
      return;
    }

    try {
      const res = await authFetch(`${API_URL}/admin/create-hr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          department: newHrForm.department,
          username: newHrForm.username.trim(),
          password: newHrForm.password,
          display_name: newHrForm.display_name.trim() || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || "Failed to generate HR credentials.");
      }

      setHrCreateStatus({
        loading: false,
        error: "",
        success: `HR credentials for ${newHrForm.department} generated successfully.`,
      });
      setNewHrForm({
        department: dbDepartments[0] || "Innovation",
        username: "",
        password: "",
        display_name: "",
      });
      loadHrUsers();
    } catch (err) {
      setHrCreateStatus({
        loading: false,
        error: err.message || "Unable to generate HR account.",
        success: "",
      });
    }
  };

  // Superior: Load Audit Logs
  const loadAuditLogs = async () => {
    try {
      setAuditLoading(true);
      let url = `${API_URL}/audit/logs?limit=300`;
      if (auditRoleFilter && auditRoleFilter !== "ALL") {
        url += `&actor_role=${encodeURIComponent(auditRoleFilter.toLowerCase())}`;
      }
      if (auditActionFilter && auditActionFilter !== "ALL") {
        url += `&action_type=${encodeURIComponent(auditActionFilter)}`;
      }
      if (auditDateFilter) {
        url += `&target_date=${encodeURIComponent(auditDateFilter)}`;
      }

      const res = await authFetch(url);
      if (res.ok) {
        const data = await res.json();
        setAuditLogs(Array.isArray(data) ? data : []);
      }
    } catch {
      // ignore
    } finally {
      setAuditLoading(false);
    }
  };

  // Superior: Manual Attendance Correction
  const handleManualOverride = async (event) => {
    event.preventDefault();
    setOverrideStatus({ loading: true, error: "", success: "" });

    if (!overrideForm.employee_id) {
      setOverrideStatus({ loading: false, error: "Please select an employee.", success: "" });
      return;
    }
    if (!overrideForm.reason.trim()) {
      setOverrideStatus({ loading: false, error: "A clear reason is required for manual attendance override.", success: "" });
      return;
    }

    try {
      const res = await authFetch(`${API_URL}/attendance/manual-correction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_id: overrideForm.employee_id,
          attendance_date: overrideForm.attendance_date,
          status: overrideForm.status,
          first_in: overrideForm.first_in || null,
          last_out: overrideForm.last_out || null,
          worked_minutes: Number(overrideForm.worked_minutes) || null,
          reason: overrideForm.reason.trim(),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || "Manual attendance correction failed.");
      }

      setOverrideStatus({
        loading: false,
        error: "",
        success: `Attendance corrected for ${overrideForm.employee_id} on ${overrideForm.attendance_date}. Record updated and logged to audit trail.`,
      });

      loadDashboardData();
      loadAttendanceByDate(selectedDate);
    } catch (err) {
      setOverrideStatus({
        loading: false,
        error: err.message || "Unable to correct attendance.",
        success: "",
      });
    }
  };

  const loadCameraStatus = async () => {
    try {
      setCameraError("");

      const response = await fetch(`${API_URL}/cameras/status`);

      if (!response.ok) {
        throw new Error("Unable to load camera status");
      }

      const data = await response.json();
      setCameraStatus(data);
    } catch (err) {
      setCameraError(err.message || "Unable to load camera status");
    } finally {
      setCameraLoading(false);
    }
  };

  const resetCameraDraft = () => {
    setCameraDraft({ id: null, name: "", source_type: "webcam", source: "0", roles: ["ENTRY"], enabled: true });
    setCameraActionError("");
    setCameraActionMessage("");
  };

  const saveCamera = async (event) => {
    event.preventDefault();
    setCameraBusy(true);
    setCameraActionError("");
    setCameraActionMessage("");
    try {
      const response = await fetch(`${API_URL}/cameras${cameraDraft.id ? `/${cameraDraft.id}` : ""}`, {
        method: cameraDraft.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: cameraDraft.name,
          source_type: cameraDraft.source_type,
          source: cameraDraft.source,
          roles: cameraDraft.roles,
          enabled: cameraDraft.enabled,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to save camera");
      setShowCameraEditor(false);
      resetCameraDraft();
      setCameraActionMessage(cameraDraft.id ? "Camera updated." : "Camera added.");
      await loadCameraStatus();
    } catch (err) {
      setCameraActionError(err.message || "Unable to save camera");
    } finally {
      setCameraBusy(false);
    }
  };

  const editCamera = (camera) => {
    setCameraDraft({ ...camera, source: "", roles: camera.roles || [] });
    setCameraActionError("");
    setCameraActionMessage("");
    setShowCameraEditor(true);
  };

  const toggleCameraEnabled = async (camera) => {
    try {
      const response = await fetch(`${API_URL}/cameras/${camera.id}/enabled`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !camera.enabled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to update camera");
      await loadCameraStatus();
    } catch (err) {
      setCameraActionError(err.message || "Unable to update camera");
    }
  };

  const deleteCamera = async (camera) => {
    if (!window.confirm(`Delete camera “${camera.name}”?`)) return;
    try {
      if (viewCamera?.id === camera.id) setViewCamera(null);
      const response = await fetch(`${API_URL}/cameras/${camera.id}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to delete camera");
      await loadCameraStatus();
      if (viewCamera?.id === camera.id) setViewCamera(null);
    } catch (err) {
      setCameraActionError(err.message || "Unable to delete camera");
    }
  };

  const testCamera = async (camera) => {
    try {
      setCameraActionError("");
      const response = await fetch(`${API_URL}/cameras/${camera.id}/test`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Camera connection failed");
      setCameraActionMessage(`${camera.name}: connected successfully.`);
    } catch (err) {
      setCameraActionError(err.message || "Camera connection failed");
    }
  };

  const handleCameraDraftChange = (event) => {
    const { name, value, type, checked } = event.target;
    setCameraDraft((previous) => ({ ...previous, [name]: type === "checkbox" ? checked : value }));
  };

  const toggleCameraRole = (role) => {
    setCameraDraft((previous) => ({
      ...previous,
      roles: previous.roles.includes(role)
        ? previous.roles.filter((item) => item !== role)
        : [...previous.roles, role],
    }));
  };

  const openCameraPreview = (camera) => {
    setViewCamera({ ...camera, streamId: globalThis.crypto.randomUUID() });
  };

  const closeCameraPreview = () => setViewCamera(null);

  useEffect(() => {
    if (!viewCamera) return undefined;
    const { id, streamId } = viewCamera;
    return () => {
      fetch(`${API_URL}/cameras/${id}/stream/${streamId}/stop`, {
        method: "POST",
        keepalive: true,
      }).catch(() => {});
    };
  }, [viewCamera]);

  const handleAttendanceDateChange = (event) => {
    const date = event.target.value;

    setSelectedDate(date);

    if (date) {
      loadAttendanceByDate(date);
    }
  };

  useEffect(() => {
    // Dynamically load departments from database
    authFetch(`${API_URL}/departments`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setDbDepartments(data);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (auth?.must_change_password) {
      setShowPasswordModal(true);
    }
  }, [auth]);

  useEffect(() => {
    if (activePage === "attendance") {
      loadAttendanceByDate(selectedDate);
    } else if (activePage === "admin_mgmt") {
      loadAdminUsers();
    } else if (activePage === "general_access") {
      loadHrUsers();
    } else if (activePage === "audit_logs") {
      loadAuditLogs();
    } else {
      loadDashboardData();
    }

    loadCameraStatus();

    const interval = setInterval(() => {
      loadCameraStatus();

      if (activePage === "dashboard") {
        loadDashboardData();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [activePage, selectedDate, auditRoleFilter, auditActionFilter, auditDateFilter]);

  const handleEmployeeFormChange = (event) => {
    const { name, value } = event.target;

    setEmployeeForm((previous) => ({
      ...previous,
      [name]: value,
    }));

    if (name === "login_id") {
      setHubbleError("");
      setHubbleEmployee(null);
    }
  };

  const fetchHubbleEmployee = async (loginIdOverride = null) => {
    const loginId = String(
      loginIdOverride ?? employeeForm.login_id ?? ""
    ).trim();

    if (!loginId) {
      setHubbleError("Please enter a Hubble Login ID.");
      return;
    }

    setHubbleLoading(true);
    setHubbleError("");
    setFormError("");

    try {
      let response;
      try {
        response = await fetch(
          `${API_URL}/mock-hubble/employee/${encodeURIComponent(loginId)}`,
          { headers: { Accept: "application/json" } }
        );
      } catch {
        response = null;
      }

      if (!response || !response.ok) {
        response = await fetch(
          `${HUBBLE_API_URL}/mock-hubble/employee/${encodeURIComponent(loginId)}`,
          { headers: { Accept: "application/json" } }
        );
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          data?.detail || `Hubble employee not found (${response.status})`
        );
      }

      const normalizedEmployee = {
        ...data,
        employee_id: data.id ?? "",
        employee_name: data.name ?? "",
        email: data.mailId ?? "",
        login_id: data.loginId ?? loginId,
        reporting_manager: data.reportsTo ?? "",
        hr_contact: data.hrContact ?? "",
        department: data.department ?? "",
        designation: data.designation ?? "",
        team: data.teamName ?? "",
      };

      setHubbleEmployee(normalizedEmployee);
      setEmployeeForm((previous) => ({
        ...previous,
        login_id: normalizedEmployee.login_id,
        employee_id: normalizedEmployee.employee_id !== ""
          ? String(normalizedEmployee.employee_id)
          : previous.employee_id,
        employee_name: normalizedEmployee.employee_name || previous.employee_name,
        email: normalizedEmployee.email || previous.email,
        department: auth?.role === "hr" ? auth.department : (normalizedEmployee.department || previous.department || "Software Services"),
      }));
      setFormMessage(
        `Mock Hubble employee found: ${normalizedEmployee.employee_name || loginId}`
      );
    } catch (error) {
      setHubbleEmployee(null);
      setHubbleError(error.message || "Unable to fetch employee details from Hubble.");
    } finally {
      setHubbleLoading(false);
    }
  };

  const handleHubbleLoginKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      fetchHubbleEmployee();
    }
  };

  const startEnrollmentCamera = async () => {
    setCaptureError("");

    try {
      if (cameraStream) {
        cameraStream.getTracks?.().forEach((track) => track.stop());
      }

      if (enrollmentCameraId) {
        const response = await fetch(`${API_URL}/cameras/${enrollmentCameraId}/test`, { method: "POST" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Selected camera is not connected");
        setCameraStream({ cameraId: enrollmentCameraId, streamId: globalThis.crypto.randomUUID() });
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access is not supported by this browser.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },
        audio: false,
      });

      setCameraStream(stream);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (err) {
      setCaptureError(
        err.message ||
          "Unable to access the camera. Please allow camera permission."
      );
    }
  };

  const stopEnrollmentCamera = () => {
    if (cameraStream?.cameraId && cameraStream?.streamId) {
      fetch(`${API_URL}/cameras/${cameraStream.cameraId}/stream/${cameraStream.streamId}/stop`, {
        method: "POST",
        keepalive: true,
      }).catch(() => {});
    }
    if (cameraStream) {
      cameraStream.getTracks?.().forEach((track) => track.stop());
    }

    setCameraStream(null);

    holdCountRef.current = 0;
    setPoseState({
      status: "idle",
      message: "Start the camera to begin.",
      debug: null,
    });

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (cameraImageRef.current) cameraImageRef.current.src = "";
  };

  useEffect(() => {
    if (cameraStream?.getTracks && videoRef.current) {
      videoRef.current.srcObject = cameraStream;
      videoRef.current.play().catch(() => {});
    }
  }, [cameraStream]);

  useEffect(() => {
    const image = cameraImageRef.current;
    if (cameraStream?.cameraId && image) {
      image.src = `${API_URL}/cameras/${cameraStream.cameraId}/stream.mjpg?stream_id=${encodeURIComponent(cameraStream.streamId)}`;
    }
    return () => {
      if (image) image.src = "";
      if (cameraStream?.cameraId && cameraStream?.streamId) {
        fetch(`${API_URL}/cameras/${cameraStream.cameraId}/stream/${cameraStream.streamId}/stop`, {
          method: "POST",
          keepalive: true,
        }).catch(() => {});
      }
    };
  }, [cameraStream]);


  useEffect(() => {
    return () => {
      if (cameraStream) {
        cameraStream.getTracks?.().forEach((track) => track.stop());
      }
    };
  }, [cameraStream]);

  const resetEnrollmentState = () => {
    stopEnrollmentCamera();

    capturedPhotos.forEach((photo) => {
      if (photo.previewUrl) {
        URL.revokeObjectURL(photo.previewUrl);
      }
    });

    setCapturedPhotos([]);
    setSkippedSteps([]);
    baselineRef.current = { ...EMPTY_BASELINE };
    holdCountRef.current = 0;
    setCaptureError("");
    setEnrollmentLoading(false);
  };

  const resetAddEmployeeState = () => {
    resetEnrollmentState();
    setEmployeeForm({
      employee_id: "",
      employee_name: "",
      shift_start: "14:00",
      shift_end: "22:00",
      email: "",
      login_id: "",
      department: auth?.role === "hr" ? auth.department : "Software Services",
      work_location: "Miracle City (HQ)",
      is_flexible_shift: false,
    });
    setHubbleEmployee(null);
    setHubbleError("");
    setHubbleLoading(false);
    setFormMessage("");
    setFormError("");
  };

  const closeAddEmployee = () => {
    resetAddEmployeeState();
    setShowAddEmployee(false);
  };

  // Reset all temporary form state whenever the Add Employee modal is closed or not open
  useEffect(() => {
    if (!showAddEmployee) {
      resetAddEmployeeState();
    }
  }, [showAddEmployee]);

  // Automatically fetch employee details when entering lookup information (login_id)
  useEffect(() => {
    if (!showAddEmployee) return;
    const trimmed = (employeeForm.login_id || "").trim();
    if (!trimmed || trimmed.length < 3) return;

    const timer = setTimeout(() => {
      if (hubbleEmployee?.login_id?.toLowerCase() !== trimmed.toLowerCase() && !hubbleLoading) {
        fetchHubbleEmployee(trimmed);
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [employeeForm.login_id, showAddEmployee]);

  const getEnrollmentImageElement = () =>
    enrollmentCameraId ? cameraImageRef.current : videoRef.current;

  // Small frame (fast to upload) used only to read the head angle.
  const grabPoseFrameBlob = () =>
    new Promise((resolve) => {
      const video = getEnrollmentImageElement();
      const width = video?.videoWidth || video?.naturalWidth || 0;
      const height = video?.videoHeight || video?.naturalHeight || 0;
      const ready = enrollmentCameraId
        ? video?.complete && width > 0
        : video?.readyState >= 2 && width > 0;

      if (!video || !ready) {
        resolve(null);
        return;
      }

      if (!poseCanvasRef.current) {
        poseCanvasRef.current = document.createElement("canvas");
      }

      const canvas = poseCanvasRef.current;
      const scale = 480 / width;

      canvas.width = 480;
      canvas.height = Math.round(height * scale);

      const context = canvas.getContext("2d");

      if (!context) {
        resolve(null);
        return;
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.7);
    });

  // Full-resolution photo of ONLY the employee:
  //  - every other face in the frame is painted over
  //  - the picture is cropped around the employee's face
  // (the enrollment API rejects photos that contain 2+ faces)
  const grabEmployeeCropBlob = (target, others) =>
    new Promise((resolve) => {
      const video = getEnrollmentImageElement();
      const canvas = canvasRef.current;
      const width = video?.videoWidth || video?.naturalWidth || 0;
      const height = video?.videoHeight || video?.naturalHeight || 0;
      const ready = enrollmentCameraId
        ? video?.complete && width > 0
        : video?.readyState >= 2 && width > 0;

      if (!video || !canvas || !ready) {
        resolve(null);
        return;
      }

      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");

      if (!context) {
        resolve(null);
        return;
      }

      context.drawImage(video, 0, 0, width, height);

      const box = target.bbox;
      const faceW = (box.x2 - box.x1) * width;
      const faceH = (box.y2 - box.y1) * height;
      const centerX = ((box.x1 + box.x2) / 2) * width;
      const centerY = ((box.y1 + box.y2) / 2) * height;

      // paint over the other people's faces
      context.fillStyle = "#808080";

      others.forEach((other) => {
        const ob = other.bbox;
        const ocx = ((ob.x1 + ob.x2) / 2) * width;
        const ocy = ((ob.y1 + ob.y2) / 2) * height;

        // never paint over the employee's own face
        const insideTarget =
          ocx > centerX - faceW / 2 &&
          ocx < centerX + faceW / 2 &&
          ocy > centerY - faceH / 2 &&
          ocy < centerY + faceH / 2;

        if (insideTarget) return;

        const ow = (ob.x2 - ob.x1) * width;
        const oh = (ob.y2 - ob.y1) * height;

        context.fillRect(
          ob.x1 * width - ow * 0.15,
          ob.y1 * height - oh * 0.15,
          ow * 1.3,
          oh * 1.3
        );
      });

      // crop around the employee
      const cropW = Math.min(width, faceW * 2.2);
      const cropH = Math.min(height, faceH * 2.0);

      const sx = Math.max(0, Math.min(width - cropW, centerX - cropW / 2));
      const sy = Math.max(0, Math.min(height - cropH, centerY - cropH / 2));

      const crop = document.createElement("canvas");

      crop.width = Math.round(cropW);
      crop.height = Math.round(cropH);

      crop
        .getContext("2d")
        .drawImage(canvas, sx, sy, cropW, cropH, 0, 0, crop.width, crop.height);

      crop.toBlob((blob) => resolve(blob), "image/jpeg", 0.92);
    });

  // Automatic capture loop: checks the angle again and again and
  // captures by itself when the requested angle is held.
  useEffect(() => {
    if (!cameraStream || !currentStep || enrollmentLoading) {
      return undefined;
    }

    let cancelled = false;
    let timer = null;
    const step = currentStep;

    holdCountRef.current = 0;

    setPoseState({
      status: "idle",
      message: step.hint,
      debug: null,
    });

    const tick = async () => {
      if (cancelled) return;

      try {
        if (Date.now() < cooldownUntilRef.current) return;

        const frame = await grabPoseFrameBlob();
        if (!frame || cancelled) return;

        const body = new FormData();
        body.append("file", frame, "frame.jpg");

        const response = await fetch(`${API_URL}/face-pose`, {
          method: "POST",
          body,
        });

        if (!response.ok) throw new Error("Pose check failed");

        const data = await response.json();
        if (cancelled) return;

        const video = getEnrollmentImageElement();
        const aspect =
          video && (video.videoHeight || video.naturalHeight)
            ? (video.videoWidth || video.naturalWidth) / (video.videoHeight || video.naturalHeight)
            : 16 / 9;

        const result = evaluatePose(step, data, baselineRef.current, aspect);
        const target = result.target;

        const debug =
          target && target.pose
            ? {
                yaw: result.yaw ?? 0,
                pitch: result.pitch ?? 0,
                yawCue: target.yaw_cue,
                pitchCue: target.pitch_cue,
                faces: data.faces.length,
              }
            : null;

        if (!result.ok) {
          holdCountRef.current = 0;

          setPoseState({
            status: result.idle ? "idle" : "bad",
            message: result.message,
            debug,
          });

          return;
        }

        holdCountRef.current += 1;

        if (holdCountRef.current < HOLD_FRAMES) {
          setPoseState({ status: "ok", message: result.message, debug });
          return;
        }

        // Angle held long enough -> capture only the employee.
        const others = data.faces.filter((face) => face !== target);
        const blob = await grabEmployeeCropBlob(target, others);

        if (!blob || cancelled) return;

        // The front photo is the reference for every other angle.
        if (step.id === "front") {
          baselineRef.current = {
            yaw: target.pose.yaw,
            pitch: target.pose.pitch,
            yawCue: target.yaw_cue,
            pitchCue: target.pitch_cue,
          };
        }

        const previewUrl = URL.createObjectURL(blob);

        holdCountRef.current = 0;
        cooldownUntilRef.current = Date.now() + CAPTURE_COOLDOWN_MS;

        setCapturedPhotos((previous) =>
          previous.some((photo) => photo.poseId === step.id)
            ? previous
            : [
                ...previous,
                {
                  blob,
                  previewUrl,
                  poseId: step.id,
                  filename: `face_${step.id}.jpg`,
                },
              ]
        );

        setPoseState({
          status: "done",
          message: `${step.label} captured. Next angle...`,
          debug,
        });
      } catch {
        if (!cancelled) {
          setPoseState({
            status: "idle",
            message: "Cannot reach the face service. Is the API running?",
            debug: null,
          });
        }
      }
    };

    // Run one check at a time: the next one is scheduled only after
    // the previous one finished, so slow frames never pile up.
    const loop = async () => {
      await tick();

      if (!cancelled) {
        timer = setTimeout(loop, POLL_MS);
      }
    };

    loop();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraStream, currentStep?.id, enrollmentLoading]);

  const skipCurrentStep = () => {
    if (!currentStep) return;
    setSkippedSteps((previous) => [...previous, currentStep.id]);
  };

  const removeCapturedPhoto = (index) => {
    setCapturedPhotos((previous) => {
      const photo = previous[index];

      if (photo?.previewUrl) {
        URL.revokeObjectURL(photo.previewUrl);
      }

      return previous.filter((_, photoIndex) => photoIndex !== index);
    });
  };

  const addEmployee = async (event) => {
    event.preventDefault();

    setFormMessage("");
    setFormError("");
    setCaptureError("");

    if (capturedPhotos.length < 5) {
      setCaptureError(
        "Please capture at least 5 angles before adding the employee."
      );
      return;
    }

    if (capturedPhotos.length > 10) {
      setCaptureError("You can capture a maximum of 10 photos.");
      return;
    }

    setEnrollmentLoading(true);

    let employeeCreated = false;

    try {
      // ----------------------------------------------------
      // STEP 1: CREATE EMPLOYEE
      // ----------------------------------------------------

      const employeeResponse = await authFetch(`${API_URL}/employees`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(employeeForm),
      });

      const employeeData = await employeeResponse.json();

      if (!employeeResponse.ok) {
        throw new Error(
          employeeData.detail || "Unable to add employee"
        );
      }

      employeeCreated = true;

      // ----------------------------------------------------
      // STEP 2: SEND CAPTURED PHOTOS FOR FACE ENROLLMENT
      // ----------------------------------------------------

      const formData = new FormData();

      capturedPhotos.forEach((photo, index) => {
        formData.append(
          "files",
          photo.blob,
          photo.filename || `face_${index + 1}.jpg`
        );
      });

      const enrollmentResponse = await authFetch(
        `${API_URL}/employees/${encodeURIComponent(
          employeeForm.employee_id
        )}/enroll-face`,
        {
          method: "POST",
          body: formData,
        }
      );

      const enrollmentData = await enrollmentResponse.json();

      if (!enrollmentResponse.ok) {
        const detail =
          typeof enrollmentData.detail === "string"
            ? enrollmentData.detail
            : enrollmentData.detail?.message ||
              "Face enrollment failed.";

        throw new Error(detail);
      }

      setFormMessage(
        `Employee added and face enrolled successfully. ${enrollmentData.photos_processed || capturedPhotos.length} photos processed.`
      );

      // ----------------------------------------------------
      // CLEANUP
      // ----------------------------------------------------

      resetEnrollmentState();

      setEmployeeForm({
        employee_id: "",
        employee_name: "",
        shift_start: "14:00",
        shift_end: "22:00",
        email: "",
        login_id: "",
        department: auth?.role === "hr" ? auth.department : (allDepartments[0] || "Software Services"),
        work_location: "Miracle City (HQ)",
      });

      setHubbleEmployee(null);
      setHubbleError("");

      await loadDashboardData();

      setTimeout(() => {
        setShowAddEmployee(false);
        setFormMessage("");
      }, 1500);
    } catch (err) {
      if (employeeCreated) {
        setFormError(
          `Employee was created, but face enrollment failed: ${
            err.message || "Unknown enrollment error"
          }`
        );
      } else {
        setFormError(err.message || "Unable to add employee");
      }
    } finally {
      setEnrollmentLoading(false);
    }
  };


  const loadEmployeeAttendanceHistory = async (employee, year, month) => {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const response = await fetch(
        `${API_URL}/employees/${encodeURIComponent(employee.employee_id)}/attendance-history?year=${year}&month=${month}`
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail || "Unable to load monthly attendance.");
      }
      const records = Array.isArray(data.attendance) ? data.attendance : [];
      setAttendanceHistory(records);
      setSelectedHistoryDay((previous) =>
        previous ? records.find((day) => day.date === previous.date) || null : null
      );
      return records;
    } catch (err) {
      setAttendanceHistory([]);
      setHistoryError(err.message || "Unable to load monthly attendance.");
      return [];
    } finally {
      setHistoryLoading(false);
    }
  };

  const openEmployeeHistory = async (employee) => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    setSelectedEmployee(employee);
    setHistoryYear(year);
    setHistoryMonth(month);
    setSelectedHistoryDay(null);
    setAttendanceHistory([]);
    await loadEmployeeAttendanceHistory(employee, year, month);
  };

  const changeHistoryMonth = async (offset) => {
    if (!selectedEmployee) return;
    const next = new Date(historyYear, historyMonth - 1 + offset, 1);
    const year = next.getFullYear();
    const month = next.getMonth() + 1;
    setHistoryYear(year);
    setHistoryMonth(month);
    setSelectedHistoryDay(null);
    await loadEmployeeAttendanceHistory(selectedEmployee, year, month);
  };

  const openEditShift = (employee) => {
    setEditingEmployee(employee);
    setEditShiftForm({
      shift_start: employee.shift_start || "09:00",
      shift_end: employee.shift_end || "17:00",
      is_flexible_shift: Boolean(employee.is_flexible_shift),
    });
    setEditShiftError("");
  };

  const saveEmployeeShift = async (event) => {
    event.preventDefault();
    if (!editingEmployee) return;
    setEditShiftLoading(true);
    setEditShiftError("");
    try {
      const response = await authFetch(
        `${API_URL}/employees/${encodeURIComponent(editingEmployee.employee_id)}/shift`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(editShiftForm),
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to update shift.");
      setEmployees((previous) => previous.map((employee) =>
        String(employee.employee_id) === String(data.employee.employee_id)
          ? { ...employee, ...data.employee }
          : employee
      ));
      setEditingEmployee(null);
      await loadDashboardData();
    } catch (err) {
      setEditShiftError(err.message || "Unable to update shift.");
    } finally {
      setEditShiftLoading(false);
    }
  };

  const saveSelectedDayLeave = async () => {
    if (!selectedEmployee || !selectedHistoryDay) return;
    if (selectedHistoryDay.status === "WEEKEND") {
      setHistoryError("Leave records cannot be added to weekends.");
      return;
    }
    const leaveType = window.prompt("Leave type", selectedHistoryDay.leave_type || "Leave");
    if (leaveType === null) return;
    const reason = window.prompt("Reason (optional)", selectedHistoryDay.reason || "");
    if (reason === null) return;
    setLeaveSaving(true);
    setHistoryError("");
    try {
      const response = await authFetch(
        `${API_URL}/employees/${encodeURIComponent(selectedEmployee.employee_id)}/leave`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            employee_id: String(selectedEmployee.employee_id),
            leave_date: selectedHistoryDay.date,
            leave_type: leaveType.trim() || "Leave",
            reason: reason.trim() || null,
          }),
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to save leave.");
      const records = await loadEmployeeAttendanceHistory(selectedEmployee, historyYear, historyMonth);
      setSelectedHistoryDay(records.find((day) => day.date === selectedHistoryDay.date) || null);
    } catch (err) {
      setHistoryError(err.message || "Unable to save leave.");
    } finally {
      setLeaveSaving(false);
    }
  };

  const removeSelectedDayLeave = async () => {
    if (!selectedEmployee || !selectedHistoryDay || selectedHistoryDay.status !== "LEAVE") return;
    if (!window.confirm(`Remove leave recorded for ${selectedHistoryDay.date}?`)) return;
    setLeaveSaving(true);
    setHistoryError("");
    try {
      const response = await authFetch(
        `${API_URL}/employees/${encodeURIComponent(selectedEmployee.employee_id)}/leave/${selectedHistoryDay.date}`,
        { method: "DELETE" }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to remove leave.");
      const records = await loadEmployeeAttendanceHistory(selectedEmployee, historyYear, historyMonth);
      setSelectedHistoryDay(records.find((day) => day.date === selectedHistoryDay.date) || null);
    } catch (err) {
      setHistoryError(err.message || "Unable to remove leave.");
    } finally {
      setLeaveSaving(false);
    }
  };

  const openReportChooser = (employee = null) => {
    setReportChooser(employee ? { employee } : { employee: null });
    setReportPeriod("month");
    const today = selectedDate || new Date().toISOString().slice(0, 10);
    setReportDate(today);
    setReportStartDate(today);
    setReportEndDate(today);
    setReportError("");
  };

  const downloadAttendanceReport = async () => {
    if (!reportChooser || reportDownloading) return;
    setReportDownloading(true);
    setReportError("");

    if (reportPeriod === "custom") {
      if (!reportStartDate || !reportEndDate) {
        setReportError("Both start date and end date are required for custom range.");
        setReportDownloading(false);
        return;
      }
      if (reportStartDate > reportEndDate) {
        setReportError("Start date cannot be after end date.");
        setReportDownloading(false);
        return;
      }
    }

    try {
      const employee = reportChooser.employee;
      const endpoint = employee
        ? `/reports/employee/${encodeURIComponent(employee.employee_id)}`
        : "/reports/attendance";

      let queryUrl = `${API_URL}${endpoint}?period=${encodeURIComponent(reportPeriod)}`;
      if (reportPeriod === "custom") {
        queryUrl += `&start_date=${encodeURIComponent(reportStartDate)}&end_date=${encodeURIComponent(reportEndDate)}`;
      } else {
        queryUrl += `&date=${encodeURIComponent(reportDate)}`;
      }

      const response = await authFetch(queryUrl);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || "Unable to download attendance report.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1]
        || `${employee ? employee.employee_id : "all_employees"}_${reportPeriod}_attendance.xlsx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setReportChooser(null);
    } catch (err) {
      setReportError(err.message || "Unable to download attendance report.");
    } finally {
      setReportDownloading(false);
    }
  };

  const deleteEmployee = async (employee) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete ${employee.employee_name}?\n\n` +
        `This will permanently remove the employee, face embeddings, ` +
        `attendance events, and attendance summary.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setDeletingEmployeeId(String(employee.employee_id));
      setError("");

      const response = await authFetch(
        `${API_URL}/employees/${employee.employee_id}`,
        {
          method: "DELETE",
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.detail || "Unable to delete employee"
        );
      }

      if (
        selectedEmployee &&
        String(selectedEmployee.employee_id) ===
          String(employee.employee_id)
      ) {
        closeHistory();
      }

      await loadDashboardData();
      if (selectedDate) {
        loadAttendanceByDate(selectedDate);
      }
    } catch (err) {
      setError(
        err.message || "Unable to delete employee"
      );
    } finally {
      setDeletingEmployeeId(null);
    }
  };

  const closeHistory = () => {
    setSelectedEmployee(null);
    setAttendanceHistory([]);
    setSelectedHistoryDay(null);
    setHistoryError("");
  };

  const getAttendance = (employeeId) => {
    return attendance.find(
      (record) => String(record.employee_id) === String(employeeId)
    );
  };

  const getStatus = (record) => {
    if (!record) return "ABSENT";

    // /attendance/today includes a summary row for every employee,
    // including employees who have not checked in today.
    if (!record.first_in && Number(record.event_count || 0) === 0) {
      return "ABSENT";
    }

    const status = String(record.arrival_status || "").toUpperCase();

    if (status === "EARLY") return "EARLY";
    if (status === "LATE") return "LATE";
    if (status === "ON_TIME" || status === "ON TIME") return "ON_TIME";

    return status || (record.first_in ? "PRESENT" : "ABSENT");
  };

  const formatStatus = (status) => {
    if (status === "ON_TIME") return "ON TIME";
    if (status === "ABSENT") return "ABSENT";
    return status;
  };

  const allDepartments = useMemo(() => {
    const list = Array.from(
      new Set([
        ...dbDepartments,
        ...employees.map((e) => e.department).filter(Boolean),
      ])
    );
    return list.sort();
  }, [employees, dbDepartments]);

  const allLocations = useMemo(() => {
    const list = Array.from(
      new Set(
        employees.map((e) => e.work_location || e.location).filter(Boolean)
      )
    );
    if (list.length === 0) {
      return ["Miracle City (HQ)", "Miracle Valley", "Tech Center", "Remote / Field"].sort();
    }
    return list.sort();
  }, [employees]);

  const authorizedEmployees = useMemo(() => {
    if (auth?.role === "hr" && auth?.department) {
      const targetDept = auth.department.toLowerCase().trim();
      return employees.filter(
        (emp) =>
          (emp.department || "").toLowerCase().trim() === targetDept
      );
    }
    return employees;
  }, [employees, auth]);

  const filteredEmployees = useMemo(() => {
    return authorizedEmployees.filter((employee) => {
      const employeeAttendance = getAttendance(employee.employee_id);
      const status = getStatus(employeeAttendance);

      // 1. Employee Name, ID, Login ID, Email, or Mobile Filter
      const query = search.toLowerCase().trim();
      const matchesSearch =
        !query ||
        String(employee.employee_id || "").toLowerCase().includes(query) ||
        String(employee.employee_name || "")
          .toLowerCase()
          .includes(query) ||
        String(employee.login_id || "")
          .toLowerCase()
          .includes(query) ||
        String(employee.email || "")
          .toLowerCase()
          .includes(query) ||
        String(employee.phone || employee.mobile || "")
          .toLowerCase()
          .includes(query);

      // 2. Department Filter
      let matchesDept = true;
      if (deptFilter && deptFilter !== "ALL") {
        matchesDept =
          (employee.department || "").toLowerCase().trim() ===
          deptFilter.toLowerCase().trim();
      }

      // 3. Work Location Filter
      let matchesLocation = true;
      if (locationFilter && locationFilter !== "ALL") {
        const empLoc = (employee.work_location || employee.location || "").toLowerCase().trim();
        matchesLocation = empLoc === locationFilter.toLowerCase().trim();
      }

      // 4. Status Filter
      let matchesStatus = true;
      if (statusFilter === "ALL") {
        matchesStatus = true;
      } else if (statusFilter === "PRESENT") {
        matchesStatus = status !== "ABSENT";
      } else if (statusFilter === "EARLY") {
        matchesStatus = status === "EARLY";
      } else if (statusFilter === "LATE") {
        matchesStatus = status === "LATE";
      } else if (statusFilter === "ON_TIME") {
        matchesStatus = status === "ON_TIME";
      } else if (statusFilter === "ABSENT") {
        matchesStatus = status === "ABSENT";
      } else if (statusFilter === "HALF_DAY") {
        matchesStatus = status === "HALF_DAY";
      } else if (statusFilter === "INSIDE" || statusFilter === "INSIDE_NOW") {
        matchesStatus =
          String(employeeAttendance?.current_state || "").toUpperCase() ===
          "INSIDE";
      } else if (statusFilter === "OUTSIDE") {
        matchesStatus =
          String(employeeAttendance?.current_state || "").toUpperCase() ===
          "OUTSIDE";
      }

      return matchesSearch && matchesDept && matchesLocation && matchesStatus;
    });
  }, [authorizedEmployees, attendance, search, deptFilter, locationFilter, statusFilter]);

  // Sort employees strictly in alphabetical order by name for Miracle Attendance view
  const sortedAttendanceEmployees = useMemo(() => {
    return [...filteredEmployees].sort((a, b) =>
      (a.employee_name || "").localeCompare(b.employee_name || "", undefined, { sensitivity: "base" })
    );
  }, [filteredEmployees]);

  // Employee Directory list filtered only by search, department, and work location (independent of attendance status)
  const directoryEmployees = useMemo(() => {
    return authorizedEmployees.filter((employee) => {
      const query = search.toLowerCase().trim();
      const matchesSearch =
        !query ||
        String(employee.employee_id || "").toLowerCase().includes(query) ||
        String(employee.employee_name || "").toLowerCase().includes(query) ||
        String(employee.login_id || "").toLowerCase().includes(query) ||
        String(employee.email || "").toLowerCase().includes(query) ||
        String(employee.phone || employee.mobile || "").toLowerCase().includes(query);

      let matchesDept = true;
      if (deptFilter && deptFilter !== "ALL") {
        matchesDept =
          (employee.department || "").toLowerCase().trim() ===
          deptFilter.toLowerCase().trim();
      }

      let matchesLocation = true;
      if (locationFilter && locationFilter !== "ALL") {
        const empLoc = (employee.work_location || employee.location || "").toLowerCase().trim();
        matchesLocation = empLoc === locationFilter.toLowerCase().trim();
      }

      return matchesSearch && matchesDept && matchesLocation;
    });
  }, [authorizedEmployees, search, deptFilter, locationFilter]);

  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (!e.target.closest(".miracle-profile-wrapper")) {
        setShowProfileDropdown(false);
      }
    };
    if (showProfileDropdown) {
      document.addEventListener("click", handleOutsideClick);
    }
    return () => {
      document.removeEventListener("click", handleOutsideClick);
    };
  }, [showProfileDropdown]);

  const totalEmployees = authorizedEmployees.length;


  const authorizedEmployeeIds = useMemo(() => {
    return new Set(authorizedEmployees.map((e) => String(e.employee_id)));
  }, [authorizedEmployees]);

  const authorizedAttendance = useMemo(() => {
    return attendance.filter((record) =>
      authorizedEmployeeIds.has(String(record.employee_id))
    );
  }, [attendance, authorizedEmployeeIds]);

  const presentToday = authorizedAttendance.filter(
    (record) => getStatus(record) !== "ABSENT"
  ).length;

  const lateToday = authorizedAttendance.filter(
    (record) => getStatus(record) === "LATE"
  ).length;

  const insideNow = authorizedAttendance.filter(
    (record) =>
      String(record.current_state || "").toUpperCase() === "INSIDE"
  ).length;

  const cameras = cameraStatus?.cameras || [];
  const enrollmentCameras = cameras.filter((camera) => camera.enabled);

  const formatMinutes = (minutes) => {
    const value = Number(minutes || 0);

    const hours = Math.floor(value / 60);
    const mins = value % 60;

    if (hours === 0) return `${mins}m`;

    return `${hours}h ${mins}m`;
  };

  const formatWorkedTime = (record) => {
    if (record?.worked_hours) {
      return record.worked_hours;
    }

    if (record?.worked_minutes !== undefined && record?.worked_minutes !== null && Number(record.worked_minutes) > 0) {
      return formatMinutes(record.worked_minutes);
    }

    return record?.first_in ? "0m" : "--";
  };

  const formatBreakTime = (record) => {
    if (record?.break_hours) return record.break_hours;
    if (record?.break_minutes !== undefined && record?.break_minutes !== null && record?.break_minutes > 0) {
      return formatMinutes(record.break_minutes);
    }
    return record?.first_in ? "0m" : "--";
  };

  const formatTime = (time) => {
    if (!time) return "--";

    const parts = String(time).split(":");

    if (parts.length < 2) return time;

    let hour = Number(parts[0]);
    const minute = parts[1];

    const suffix = hour >= 12 ? "PM" : "AM";

    hour = hour % 12 || 12;

    return `${hour}:${minute} ${suffix}`;
  };

  const todayText = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const selectedDateText = selectedDate
    ? new Date(`${selectedDate}T00:00:00`).toLocaleDateString("en-IN", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : "";

  const statusClass = (status) => {
    switch (status) {
      case "EARLY":
        return "status-early";

      case "LATE":
        return "status-late";

      case "ON_TIME":
        return "status-ontime";

      case "INSIDE":
        return "status-inside";

      case "OUTSIDE":
        return "status-outside";

      case "ABSENT":
        return "status-absent";

      default:
        return "status-neutral";
    }
  };

  if (!auth) {
    return (
      <LoginPage
        onLogin={(user) => {
          setAuth(user);
          setActivePage("dashboard");
          try {
            sessionStorage.setItem("faceattend_auth", JSON.stringify(user));
          } catch {}
        }}
        apiBaseUrl={API_URL}
      />
    );
  }

  return (
    <div className="miracle-shell app-shell">
      <style>{`
        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system,
            BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: #f5f7fb;
          color: #172033;
        }

        button,
        input,
        select {
          font: inherit;
        }

        button {
          cursor: pointer;
        }

        :root {
          /* Official Miracle Corporate Standard Colors (Pantone / Hex) */
          --miracle-light-blue: #00AAE7;
          --miracle-medium-blue: #2368A0;
          --miracle-dark-blue: #0D416B;
          --miracle-red: #EF4048;
          --miracle-black: #232527;
          --miracle-white: #FFFFFF;
          --miracle-dark-grey: #8C8C8C;
          --miracle-light-grey: #B7B2B3;

          /* Shared Semantic Tokens */
          --color-brand-primary: var(--miracle-light-blue);
          --color-brand-secondary: var(--miracle-medium-blue);
          --color-brand-dark: var(--miracle-dark-blue);
          --color-danger: var(--miracle-red);
          --color-dark: var(--miracle-black);
          --color-surface: var(--miracle-white);
          --color-muted: var(--miracle-dark-grey);
          --color-border-subtle: var(--miracle-light-grey);
          --color-border: #e2e8f0;
          --color-bg-page: #f5f7fb;
        }

        .miracle-shell {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          background: #f5f7fb;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: var(--miracle-black);
        }

        /* Topbar */
        .miracle-topbar {
          height: 54px;
          background: #ffffff;
          border-bottom: 1px solid #e5e7eb;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 20px;
          position: sticky;
          top: 0;
          z-index: 100;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
        }

        .miracle-topbar-left {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .miracle-nav-brand {
          display: flex;
          align-items: center;
          user-select: none;
          cursor: pointer;
        }

        .miracle-navbar-logo {
          height: 32px;
          width: auto;
          max-height: 36px;
          display: block;
          object-fit: contain;
          transition: opacity 0.15s ease;
        }

        .miracle-navbar-logo:hover {
          opacity: 0.88;
        }

        .miracle-menu-toggle {
          background: transparent;
          border: none;
          color: #475569;
          padding: 6px;
          border-radius: 4px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.15s, color 0.15s;
        }

        .miracle-menu-toggle:hover {
          background: #f1f5f9;
          color: #0f172a;
        }

        .miracle-app-shortcuts {
          display: flex;
          align-items: center;
          gap: 5px;
          margin-left: 8px;
        }

        .miracle-shortcut-pill {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 3px;
          font-size: 11px;
          font-weight: 800;
          color: #ffffff;
          user-select: none;
        }

        .shortcut-m { background: #004d71; }
        .shortcut-me { background: #002b49; color: #ef4444; font-size: 9.5px; }
        .shortcut-b { background: #d32f2f; }
        .shortcut-h { background: #212529; }

        .miracle-platform-badge {
          background: #e0f2fe;
          color: #0284c7;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          padding: 3px 8px;
          border-radius: 3px;
          margin-left: 4px;
        }

        .miracle-topbar-right {
          display: flex;
          align-items: center;
          gap: 14px;
        }

        .miracle-role-pill {
          font-size: 11.5px;
          font-weight: 700;
          padding: 4px 10px;
          border-radius: 9999px;
          letter-spacing: 0.2px;
        }

        .miracle-role-pill.superior {
          background: #fef2f2;
          color: #b91c1c;
          border: 1px solid #fecaca;
        }

        .miracle-role-pill.admin {
          background: #eff6ff;
          color: #1d4ed8;
          border: 1px solid #bfdbfe;
        }

        .miracle-role-pill.hr {
          background: #f5f3ff;
          color: #6d28d9;
          border: 1px solid #ddd6fe;
        }

        .miracle-system-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 600;
          color: #475569;
        }

        .miracle-status-dot {
          width: 7px;
          height: 7px;
          background: #10b981;
          border-radius: 50%;
          box-shadow: 0 0 0 3px #d1fae5;
        }

        .miracle-profile-wrapper {
          position: relative;
        }

        .miracle-profile-trigger {
          display: flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
          padding: 4px 8px;
          border-radius: 6px;
          transition: background 0.15s;
          user-select: none;
        }

        .miracle-profile-trigger:hover {
          background: #f8fafc;
        }

        .miracle-user-name {
          font-size: 13.5px;
          font-weight: 600;
          color: #334155;
          max-width: 160px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .miracle-avatar-circle {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: linear-gradient(135deg, #0284c7, #00a8cc);
          color: #ffffff;
          font-size: 13px;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px solid #e2e8f0;
          box-shadow: 0 1px 2px rgba(0,0,0,0.06);
        }

        .miracle-dropdown-menu {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          width: 220px;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.14), 0 8px 10px -6px rgba(0, 0, 0, 0.08);
          z-index: 120;
          padding: 6px 0;
          animation: dropdownAppear 0.15s ease-out;
        }

        @keyframes dropdownAppear {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .miracle-dropdown-arrow {
          position: absolute;
          top: -6px;
          right: 20px;
          width: 10px;
          height: 10px;
          background: #ffffff;
          border-top: 1px solid #e2e8f0;
          border-left: 1px solid #e2e8f0;
          transform: rotate(45deg);
        }

        .miracle-dropdown-header {
          padding: 8px 16px 10px;
        }

        .dropdown-user-title {
          font-size: 13px;
          font-weight: 700;
          color: #1e293b;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .dropdown-user-role {
          font-size: 11px;
          color: #64748b;
          margin-top: 2px;
        }

        .miracle-dropdown-divider {
          height: 1px;
          background: #f1f5f9;
          margin: 4px 0;
        }

        .miracle-dropdown-item {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          padding: 9px 16px;
          font-size: 13px;
          color: #334155;
          background: transparent;
          border: none;
          cursor: pointer;
          text-align: left;
          transition: background 0.12s, color 0.12s;
        }

        .miracle-dropdown-item:hover {
          background: #f8fafc;
          color: #00a8cc;
        }

        .miracle-dropdown-item.logout {
          color: #b91c1c;
          background: #fcfcfc;
        }

        .miracle-dropdown-item.logout:hover {
          background: #fef2f2;
          color: #dc2626;
        }

        /* Body Layout */
        .miracle-body-layout {
          display: flex;
          flex: 1;
          min-height: calc(100vh - 54px);
          position: relative;
        }

        /* Dark Collapsible Sidebar */
        .miracle-sidebar {
          position: fixed;
          top: 54px;
          bottom: 0;
          left: 0;
          width: 220px;
          background: var(--miracle-black, #232527);
          color: var(--miracle-dark-grey, #8C8C8C);
          transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          z-index: 40;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          overflow-y: auto;
          overflow-x: hidden;
          border-right: 1px solid rgba(0, 0, 0, 0.15);
        }

        .miracle-sidebar.collapsed {
          width: 60px;
        }

        .miracle-sidebar-menu {
          padding: 12px 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .miracle-sidebar-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 18px;
          color: #9ca3af;
          background: transparent;
          border: none;
          width: 100%;
          cursor: pointer;
          font-size: 13.5px;
          font-weight: 500;
          text-align: left;
          transition: all 0.15s ease;
          user-select: none;
          border-left: 3px solid transparent;
        }

        .miracle-sidebar.collapsed .miracle-sidebar-item {
          justify-content: center;
          padding: 14px 0;
        }

        .miracle-sidebar-item:hover {
          background: #2d3033;
          color: var(--miracle-white, #ffffff);
        }

        .miracle-sidebar-item.active {
          background: rgba(0, 170, 231, 0.12);
          color: var(--miracle-light-blue, #00AAE7);
          border-left: 3px solid var(--miracle-light-blue, #00AAE7);
          font-weight: 600;
        }

        .miracle-sidebar-item .sidebar-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          color: currentColor;
          width: 20px;
        }

        .miracle-sidebar-item .sidebar-label {
          font-size: 13px;
          letter-spacing: 0.1px;
        }

        .miracle-sidebar-footer {
          padding: 16px 18px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          font-size: 11px;
          color: #64748b;
          line-height: 1.5;
        }

        .sidebar-footer-role {
          font-weight: 700;
          color: #94a3b8;
        }

        .sidebar-footer-version {
          color: #64748b;
          margin-top: 2px;
        }

        /* Main Area */
        .miracle-main {
          margin-left: 220px;
          width: calc(100% - 220px);
          min-height: calc(100vh - 54px);
          transition: margin-left 0.2s cubic-bezier(0.4, 0, 0.2, 1), width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          background: #f5f7fb;
          padding-bottom: 40px;
        }

        .miracle-main.collapsed {
          margin-left: 60px;
          width: calc(100% - 60px);
        }

        /* Breadcrumb */
        .miracle-breadcrumb-bar {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 600;
          color: #64748b;
          margin-bottom: 20px;
          letter-spacing: 0.5px;
        }

        .miracle-bc-home {
          color: #64748b;
        }

        .miracle-bc-sep {
          color: #94a3b8;
          font-size: 10px;
        }

        .miracle-bc-active {
          color: #00a8cc;
          font-weight: 700;
        }

        /* Subtabs Row */
        .miracle-admin-subtabs {
          display: flex;
          align-items: center;
          gap: 4px;
          background: #e2e8f0;
          padding: 3px;
          border-radius: 6px;
          margin-bottom: 22px;
          width: fit-content;
          max-width: 100%;
          overflow-x: auto;
        }

        .miracle-subtab {
          border: none;
          background: transparent;
          padding: 7px 14px;
          border-radius: 4px;
          font-size: 12.5px;
          font-weight: 600;
          color: #475569;
          cursor: pointer;
          transition: all 0.15s;
          white-space: nowrap;
        }

        .miracle-subtab:hover {
          color: #0f172a;
        }

        .miracle-subtab.active {
          background: #ffffff;
          color: var(--miracle-light-blue, #00AAE7);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
        }

        /* Attendance Miracle Redesign */
        .miracle-attendance-page {
          padding: 24px 32px;
        }

        .miracle-attendance-layout {
          display: flex;
          gap: 24px;
          align-items: flex-start;
        }

        .miracle-employee-column {
          flex: 1;
          min-width: 0;
        }

        .miracle-column-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          margin-bottom: 16px;
        }

        .miracle-list-title {
          font-size: 20px;
          font-weight: 700;
          color: var(--miracle-black, #232527);
          margin: 0;
          letter-spacing: -0.01em;
        }

        .miracle-list-subtitle {
          font-size: 12.5px;
          color: var(--miracle-dark-grey, #8C8C8C);
          margin: 4px 0 0;
        }

        .miracle-cards-scroll-container {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .miracle-employee-card {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 16px 20px;
          display: flex;
          align-items: center;
          gap: 16px;
          transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
        }

        .miracle-employee-card:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px -1px rgba(0, 0, 0, 0.08);
          border-color: var(--miracle-light-blue, #00AAE7);
        }

        .miracle-card-avatar {
          width: 52px;
          height: 52px;
          border-radius: 50%;
          background: linear-gradient(135deg, var(--miracle-dark-blue, #0D416B), var(--miracle-light-blue, #00AAE7));
          color: #ffffff;
          font-size: 17px;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.08);
          border: 2px solid #ffffff;
        }

        .miracle-card-info {
          flex: 1;
          min-width: 0;
        }

        .miracle-card-name-row {
          display: flex;
          align-items: baseline;
          gap: 8px;
          margin-bottom: 2px;
          flex-wrap: wrap;
        }

        .miracle-card-name {
          font-size: 16px;
          font-weight: 700;
          color: var(--miracle-black, #232527);
          letter-spacing: -0.01em;
        }

        .miracle-card-sep {
          color: #cbd5e1;
        }

        .miracle-card-login {
          font-size: 12.5px;
          color: var(--miracle-dark-grey, #8C8C8C);
          font-weight: 500;
        }

        .miracle-card-dept-row {
          font-size: 12.5px;
          color: #475569;
          font-weight: 500;
          margin-bottom: 4px;
        }

        .miracle-card-desig {
          color: var(--miracle-dark-grey, #8C8C8C);
          font-size: 12.5px;
        }

        .miracle-card-shift-row {
          font-size: 12px;
          color: var(--miracle-dark-grey, #8C8C8C);
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 5px;
          margin-bottom: 8px;
        }

        .miracle-card-shift-icon {
          display: inline-flex;
          align-items: center;
          color: var(--miracle-dark-grey, #8C8C8C);
          opacity: 0.85;
        }

        .miracle-card-badges-row {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }

        .miracle-pill {
          display: inline-flex;
          align-items: center;
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.2px;
        }

        .miracle-pill-shift {
          background: var(--miracle-red, #EF4048);
          color: #ffffff;
          text-transform: uppercase;
        }

        .miracle-pill-location {
          background: var(--miracle-medium-blue, #2368A0);
          color: #ffffff;
          text-transform: uppercase;
        }

        .miracle-pill-time {
          background: #f1f5f9;
          color: #334155;
          border: 1px solid #e2e8f0;
          font-weight: 500;
        }

        .miracle-pill-neutral {
          background: #f8fafc;
          color: var(--miracle-dark-grey, #8C8C8C);
          border: 1px solid #e2e8f0;
        }

        .miracle-pill-status {
          font-weight: 700;
          text-transform: uppercase;
        }

        .miracle-card-actions {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-left: auto;
          flex-shrink: 0;
        }

        .miracle-card-icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 6px;
          border: 1px solid var(--miracle-light-grey, #B7B2B3);
          background: #ffffff;
          color: var(--miracle-dark-grey, #8C8C8C);
          cursor: pointer;
          transition: all 0.15s ease-in-out;
          padding: 0;
        }

        .miracle-card-icon-btn svg {
          stroke: var(--miracle-dark-grey, #8C8C8C);
          transition: stroke 0.15s ease-in-out;
        }

        /* Hover on Edit Shift, Export Report, or View History: change to official Miracle Light Blue */
        .miracle-card-icon-btn.btn-blue:hover {
          color: var(--miracle-light-blue, #00AAE7);
          background: #f0f9ff;
          border-color: var(--miracle-light-blue, #00AAE7);
          box-shadow: 0 2px 6px rgba(0, 170, 231, 0.2);
        }

        .miracle-card-icon-btn.btn-blue:hover svg {
          stroke: var(--miracle-light-blue, #00AAE7);
        }

        /* Hover on Delete: change to official Miracle Red */
        .miracle-card-icon-btn.btn-delete:hover {
          color: var(--miracle-red, #EF4048);
          background: #fef2f2;
          border-color: var(--miracle-red, #EF4048);
          box-shadow: 0 2px 6px rgba(239, 64, 72, 0.2);
        }

        .miracle-card-icon-btn.btn-delete:hover svg {
          stroke: var(--miracle-red, #EF4048);
        }

        .miracle-card-icon-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        /* Filter Column - Fixed/Sticky while page scrolls without covering content */
        .miracle-filter-column {
          width: 310px;
          flex-shrink: 0;
          position: sticky;
          top: 74px;
          align-self: flex-start;
          max-height: calc(100vh - 90px);
          overflow-y: auto;
          scrollbar-width: thin;
        }

        .miracle-filter-card {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 22px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
        }

        .miracle-filter-section {
          margin-bottom: 18px;
        }

        .miracle-filter-label {
          display: block;
          font-size: 11px;
          font-weight: 700;
          color: #64748b;
          letter-spacing: 0.5px;
          text-transform: uppercase;
          margin-bottom: 6px;
        }

        .miracle-filter-title {
          font-size: 15px;
          font-weight: 700;
          color: #1e293b;
          margin: 20px 0 14px;
          padding-top: 14px;
          border-top: 1px solid #f1f5f9;
        }

        .miracle-search-input-group {
          display: flex;
          width: 100%;
        }

        .miracle-filter-input {
          width: 100%;
          border: 1px solid #cbd5e1;
          border-radius: 4px;
          padding: 8px 11px;
          font-size: 13px;
          color: #1e293b;
          outline: none;
          background: #ffffff;
          box-sizing: border-box;
          transition: border-color 0.15s;
        }

        .miracle-search-input-group .miracle-filter-input {
          border-top-right-radius: 0;
          border-bottom-right-radius: 0;
          border-right: none;
        }

        .miracle-filter-input:focus, .miracle-filter-select:focus {
          border-color: #00a8cc;
          box-shadow: 0 0 0 1px #00a8cc;
        }

        .miracle-search-btn {
          background: #00a8cc;
          border: 1px solid #00a8cc;
          color: #ffffff;
          padding: 0 13px;
          border-top-right-radius: 4px;
          border-bottom-right-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: background 0.15s;
        }

        .miracle-search-btn:hover {
          background: #0093b3;
        }

        .miracle-filter-select {
          width: 100%;
          border: 1px solid #cbd5e1;
          border-radius: 4px;
          padding: 8px 10px;
          font-size: 13px;
          color: #334155;
          background: #ffffff;
          outline: none;
          cursor: pointer;
        }

        .miracle-today-link {
          font-size: 11px;
          font-weight: 600;
          color: #00a8cc;
          background: none;
          border: none;
          padding: 0;
          cursor: pointer;
          text-decoration: underline;
        }

        .miracle-scoped-dept-display {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 4px;
          padding: 8px 11px;
          font-size: 13px;
          color: #334155;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .miracle-scope-badge {
          font-size: 10px;
          font-weight: 700;
          color: #6366f1;
          background: #eef2ff;
          padding: 2px 6px;
          border-radius: 3px;
        }

        .miracle-filter-actions {
          margin-top: 20px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .miracle-export-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          background: #00a8cc;
          color: #ffffff;
          border: none;
          border-radius: 4px;
          padding: 9px 14px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s;
        }

        .miracle-export-btn:hover {
          background: #0093b3;
        }

        .miracle-reset-btn {
          width: 100%;
          background: #ffffff;
          color: #64748b;
          border: 1px solid #cbd5e1;
          border-radius: 4px;
          padding: 8px 14px;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s;
        }

        .miracle-reset-btn:hover {
          background: #f8fafc;
          color: #1e293b;
        }

        /* Action Popup Modal */
        .action-popup-card {
          background: #ffffff;
          border-radius: 8px;
          width: 100%;
          max-width: 450px;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 10px 10px -5px rgba(0, 0, 0, 0.1);
          overflow: hidden;
          border: 1px solid #e2e8f0;
          animation: modalAppear 0.2s ease-out;
        }

        .action-popup-header {
          padding: 18px 22px;
          border-bottom: 1px solid #f1f5f9;
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: #f8fafc;
        }

        .action-popup-user {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .action-popup-avatar {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          background: linear-gradient(135deg, #0284c7, #00a8cc);
          color: #ffffff;
          font-size: 15px;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .action-popup-name {
          margin: 0;
          font-size: 16px;
          font-weight: 700;
          color: #1e293b;
        }

        .action-popup-meta {
          font-size: 12px;
          color: #64748b;
          margin-top: 2px;
        }

        .action-popup-close {
          background: none;
          border: none;
          font-size: 22px;
          color: #94a3b8;
          cursor: pointer;
          padding: 2px 6px;
          border-radius: 4px;
        }

        .action-popup-close:hover {
          color: #1e293b;
          background: #e2e8f0;
        }

        .action-popup-body {
          padding: 20px 22px;
        }

        .action-popup-prompt {
          margin: 0 0 14px;
          font-size: 13px;
          font-weight: 600;
          color: #64748b;
        }

        .action-options-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .action-option-btn {
          display: flex;
          align-items: center;
          gap: 14px;
          width: 100%;
          padding: 13px 16px;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          background: #ffffff;
          cursor: pointer;
          text-align: left;
          transition: all 0.15s ease;
        }

        .action-option-btn:hover {
          border-color: #00a8cc;
          background: #f0fdfa;
          transform: translateX(2px);
        }

        .action-option-btn.danger:hover {
          border-color: #fca5a5;
          background: #fef2f2;
        }

        .action-icon-box, .action-option-icon {
          width: 40px;
          height: 40px;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .action-icon-shift, .icon-shift { background: #fef3c7; color: #d97706; }
        .action-icon-history, .icon-history { background: #e0f2fe; color: #0284c7; }
        .action-icon-export, .icon-report { background: #dcfce7; color: #15803d; }
        .action-icon-delete, .icon-delete { background: #fee2e2; color: #dc2626; }

        .action-text-box, .action-option-details {
          flex: 1;
          min-width: 0;
        }

        .action-title, .action-option-title {
          font-size: 14px;
          font-weight: 700;
          color: #1e293b;
        }

        .action-desc, .action-option-desc {
          font-size: 12px;
          color: #64748b;
          margin-top: 2px;
        }

        .action-arrow {
          font-size: 18px;
          color: #cbd5e1;
          font-weight: 600;
        }

        .action-option-btn:hover .action-arrow {
          color: #00a8cc;
        }

        .action-popup-footer {
          padding: 12px 22px;
          background: #f8fafc;
          border-top: 1px solid #f1f5f9;
          display: flex;
          justify-content: flex-end;
        }

        @media (max-width: 960px) {
          .miracle-attendance-layout {
            flex-direction: column;
          }

          .miracle-filter-column {
            width: 100%;
            position: static;
            max-height: none;
          }
        }

        @media (max-width: 640px) {
          .miracle-employee-card {
            flex-wrap: wrap;
            gap: 12px;
          }

          .miracle-card-actions {
            width: 100%;
            justify-content: flex-end;
            padding-top: 8px;
            border-top: 1px solid #f1f5f9;
          }
        }

        .refresh-button {
          border: 1px solid #d0d5dd;
          background: white;
          color: #344054;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
        }

        .refresh-button:hover {
          background: #f9fafb;
        }

        .content {
          padding: 32px;
          max-width: 1700px;
          margin: auto;
        }

        .page-heading {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 28px;
        }

        .page-title {
          margin: 0;
          font-size: 27px;
          letter-spacing: -.6px;
          color: #101828;
        }

        .page-description {
          margin: 7px 0 0;
          color: #667085;
          font-size: 13px;
        }

        .primary-button {
          border: 0;
          background: var(--miracle-light-blue, #00AAE7);
          color: white;
          border-radius: 6px;
          padding: 10px 18px;
          font-weight: 600;
          font-size: 13px;
          box-shadow: 0 2px 4px rgba(0, 170, 231, 0.2);
          transition: background 0.15s, box-shadow 0.15s;
        }

        .primary-button:hover {
          background: var(--miracle-medium-blue, #2368A0);
          box-shadow: 0 4px 8px rgba(35, 104, 160, 0.25);
        }

        /* Graphical Dashboard Analytics Charts */
        .dashboard-charts-grid {
          display: grid;
          grid-template-columns: 1fr 1.35fr;
          gap: 20px;
          margin-bottom: 24px;
        }

        @media (max-width: 1024px) {
          .dashboard-charts-grid {
            grid-template-columns: 1fr;
          }
        }

        .chart-card {
          background: #ffffff;
          border: 1px solid var(--color-border, #e2e8f0);
          border-radius: 8px;
          padding: 22px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
          display: flex;
          flex-direction: column;
        }

        .chart-card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 18px;
          padding-bottom: 12px;
          border-bottom: 1px solid #f1f5f9;
        }

        .chart-card-title {
          font-size: 15px;
          font-weight: 700;
          color: var(--miracle-black, #232527);
          margin: 0;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .chart-card-badge {
          font-size: 10.5px;
          font-weight: 700;
          padding: 3px 8px;
          border-radius: 4px;
          background: #f0f9ff;
          color: var(--miracle-medium-blue, #2368A0);
          letter-spacing: 0.3px;
        }

        .donut-chart-container {
          display: flex;
          align-items: center;
          gap: 24px;
          flex: 1;
        }

        @media (max-width: 580px) {
          .donut-chart-container {
            flex-direction: column;
          }
        }

        .donut-svg-wrapper {
          position: relative;
          width: 140px;
          height: 140px;
          flex-shrink: 0;
        }

        .donut-center-info {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          pointer-events: none;
        }

        .donut-center-pct {
          font-size: 24px;
          font-weight: 800;
          color: var(--miracle-black, #232527);
          line-height: 1;
        }

        .donut-center-lbl {
          font-size: 10px;
          font-weight: 700;
          color: var(--miracle-dark-grey, #8C8C8C);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-top: 4px;
        }

        .donut-legend-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
          flex: 1;
        }

        .donut-legend-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 12.5px;
        }

        .donut-legend-left {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #334155;
          font-weight: 500;
        }

        .donut-legend-dot {
          width: 10px;
          height: 10px;
          border-radius: 3px;
          flex-shrink: 0;
        }

        .donut-legend-right {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .donut-legend-val {
          font-weight: 700;
          color: var(--miracle-black, #232527);
        }

        .donut-legend-pct {
          font-size: 11px;
          color: var(--miracle-dark-grey, #8C8C8C);
          font-weight: 500;
        }

        .metrics-bar-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          flex: 1;
          justify-content: center;
        }

        .metric-bar-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .metric-bar-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 12px;
        }

        .metric-bar-label {
          font-weight: 600;
          color: var(--miracle-black, #232527);
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .metric-bar-counts {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .metric-bar-num {
          font-weight: 700;
          color: var(--miracle-black, #232527);
        }

        .metric-bar-pct {
          color: var(--miracle-dark-grey, #8C8C8C);
          font-size: 11px;
        }

        .metric-bar-track {
          height: 9px;
          background: #f1f5f9;
          border-radius: 5px;
          overflow: hidden;
          position: relative;
        }

        .metric-bar-fill {
          height: 100%;
          border-radius: 5px;
          transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .dept-pills-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 14px;
          padding-top: 12px;
          border-top: 1px solid #f1f5f9;
        }

        .dept-pill {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 5px 9px;
          font-size: 11.5px;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .dept-pill-name {
          color: #475569;
          font-weight: 500;
        }

        .dept-pill-count {
          color: var(--miracle-medium-blue, #2368A0);
          font-weight: 700;
          background: #e0f2fe;
          padding: 1px 6px;
          border-radius: 4px;
          font-size: 10.5px;
        }

        .chart-empty-state {
          padding: 30px 20px;
          text-align: center;
          background: #f8fafc;
          border-radius: 6px;
          border: 1px dashed var(--miracle-light-grey, #B7B2B3);
        }

        .section {
          margin-bottom: 24px;
        }

        .section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 13px;
        }

        .section-title {
          font-size: 15px;
          font-weight: 700;
          color: #101828;
        }

        .section-caption {
          color: #667085;
          font-size: 12px;
        }

        .dashboard-camera-section {
          margin-bottom: 24px;
        }

        .dashboard-camera-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 16px;
        }

        .dashboard-cam-card {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          overflow: visible;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
          transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
          position: relative;
          cursor: pointer;
        }

        .dashboard-cam-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
          border-color: #00a8cc;
        }

        .dashboard-cam-card.disabled {
          opacity: 0.75;
          cursor: default;
        }

        .dashboard-cam-preview-box {
          position: relative;
          width: 100%;
          aspect-ratio: 16 / 9;
          background: #0f172a;
          border-radius: 8px 8px 0 0;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .dashboard-cam-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }

        .dashboard-cam-placeholder {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          color: #94a3b8;
          width: 100%;
          height: 100%;
          background: radial-gradient(circle at center, #1e293b, #0f172a);
        }

        .cam-placeholder-text {
          font-size: 11.5px;
          font-weight: 600;
          color: #94a3b8;
          letter-spacing: 0.3px;
        }

        .dashboard-cam-overlay-top {
          position: absolute;
          top: 10px;
          left: 10px;
          right: 10px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          pointer-events: none;
          z-index: 2;
        }

        .cam-status-pill {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 3px 8px;
          border-radius: 9999px;
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.5px;
          backdrop-filter: blur(4px);
        }

        .cam-status-pill.online {
          background: rgba(16, 185, 129, 0.9);
          color: #ffffff;
        }

        .cam-status-pill.offline {
          background: rgba(100, 116, 139, 0.85);
          color: #ffffff;
        }

        .cam-status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #ffffff;
        }

        .cam-status-pill.online .cam-status-dot {
          animation: cam-pulse 1.8s infinite;
        }

        @keyframes cam-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }

        .cam-type-pill {
          padding: 3px 7px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 700;
          background: rgba(15, 23, 42, 0.75);
          color: #e2e8f0;
          letter-spacing: 0.3px;
          border: 1px solid rgba(255, 255, 255, 0.15);
        }

        .dashboard-cam-click-hint {
          position: absolute;
          bottom: 8px;
          right: 8px;
          background: rgba(0, 0, 0, 0.65);
          color: #ffffff;
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          opacity: 0;
          transition: opacity 0.18s ease;
          pointer-events: none;
          z-index: 2;
        }

        .dashboard-cam-card:hover .dashboard-cam-click-hint {
          opacity: 1;
        }

        /* Hover Tooltip */
        .dashboard-cam-tooltip {
          position: absolute;
          bottom: calc(100% + 8px);
          left: 50%;
          transform: translateX(-50%) translateY(4px);
          background: #1e293b;
          color: #f8fafc;
          border: 1px solid #334155;
          border-radius: 6px;
          padding: 10px 12px;
          width: 250px;
          font-size: 11.5px;
          line-height: 1.45;
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.35);
          pointer-events: none;
          opacity: 0;
          visibility: hidden;
          transition: opacity 0.2s ease, transform 0.2s ease, visibility 0.2s;
          z-index: 100;
        }

        .dashboard-cam-card:hover .dashboard-cam-tooltip {
          opacity: 1;
          visibility: visible;
          transform: translateX(-50%) translateY(0);
        }

        .cam-tt-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid #334155;
          padding-bottom: 6px;
          margin-bottom: 6px;
        }

        .cam-tt-header strong {
          color: #ffffff;
          font-size: 12px;
        }

        .cam-tt-status.active { color: #34d399; font-weight: 700; font-size: 10px; }
        .cam-tt-status.inactive { color: #94a3b8; font-weight: 700; font-size: 10px; }

        .cam-tt-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 4px;
          gap: 8px;
        }

        .cam-tt-label {
          color: #94a3b8;
          font-weight: 500;
          flex-shrink: 0;
        }

        .cam-tt-val {
          color: #e2e8f0;
          font-weight: 600;
          text-align: right;
          word-break: break-all;
        }

        .dashboard-cam-info {
          padding: 12px 14px;
          background: #ffffff;
          border-top: 1px solid #f1f5f9;
          border-radius: 0 0 8px 8px;
        }

        .dashboard-cam-meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
        }

        .dashboard-cam-name {
          font-size: 13.5px;
          font-weight: 700;
          color: #1e293b;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .dashboard-cam-roles {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }

        .dashboard-cam-role-badge {
          font-size: 10px;
          font-weight: 700;
          padding: 2px 7px;
          border-radius: 4px;
          letter-spacing: 0.3px;
          text-transform: uppercase;
        }

        .role-entry {
          background: #ecfdf5;
          color: #065f46;
          border: 1px solid #a7f3d0;
        }

        .role-exit {
          background: #eff6ff;
          color: #1e40af;
          border: 1px solid #bfdbfe;
        }

        .role-enrollment {
          background: #f5f3ff;
          color: #5b21b6;
          border: 1px solid #ddd6fe;
        }

        .role-unassigned {
          background: #f1f5f9;
          color: #475569;
          border: 1px solid #cbd5e1;
        }

        .miracle-title-line {
          display: block;
          width: 32px;
          height: 3px;
          background: #00a8cc;
          border-radius: 2px;
          margin-top: 4px;
        }

        .camera-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 16px;
        }

        .camera-card {
          background: white;
          border: 1px solid #eaecf0;
          border-radius: 12px;
          padding: 20px;
        }

        .camera-empty {
          padding: 28px;
          border: 1px dashed #d0d5dd;
          border-radius: 12px;
          color: #667085;
          background: #fff;
          text-align: center;
          font-size: 13px;
        }

        .camera-card-disabled { opacity: .72; }

        .camera-card-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
          margin-top: 16px;
          padding-top: 14px;
          border-top: 1px solid #f2f4f7;
        }

        .camera-action-button {
          border: 1px solid #d0d5dd;
          background: #fff;
          color: #344054;
          border-radius: 7px;
          padding: 7px 10px;
          font-size: 11px;
          font-weight: 650;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .camera-action-button:hover { background: #f9fafb; border-color: #94a3b8; }
        .camera-action-button:disabled { opacity: .5; cursor: not-allowed; }
        .camera-action-button.danger { color: #b42318; border-color: #fecdca; }
        .camera-action-button.danger:hover { background: #fef2f2; }

        /* Camera management modal on Add Camera page */
        .camera-management-modal {
          width: min(720px, calc(100vw - 32px));
          max-height: calc(100vh - 40px);
          overflow-y: auto;
          padding: 24px;
          border-radius: 12px;
          background: #fff;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
        }

        .camera-editor-form {
          margin-top: 4px;
        }

        .camera-form-title-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .camera-form-section-heading {
          font-size: 13.5px;
          font-weight: 700;
          color: #1e293b;
        }

        .camera-form-subheading {
          font-size: 11px;
          color: #64748b;
          margin-left: 8px;
        }

        .camera-config-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }

        .camera-configured-section {
          margin-top: 24px;
          padding-top: 20px;
          border-top: 1px solid #e2e8f0;
        }

        .camera-configured-heading {
          margin-bottom: 14px;
        }

        .camera-empty-list {
          padding: 18px;
          border: 1px dashed #e2e8f0;
          border-radius: 8px;
          color: #64748b;
          text-align: center;
          font-size: 12px;
        }

        .camera-management-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .camera-mgmt-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 14px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          gap: 12px;
        }

        .camera-mgmt-item.disabled {
          opacity: 0.7;
          background: #f1f5f9;
        }

        .camera-mgmt-info {
          flex: 1;
          min-width: 0;
        }

        .camera-mgmt-name-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 4px;
        }

        .camera-mgmt-name {
          font-size: 13px;
          font-weight: 700;
          color: #1e293b;
        }

        .camera-mgmt-badge.enabled {
          color: #059669;
          font-size: 10.5px;
          font-weight: 700;
        }

        .camera-mgmt-badge.disabled {
          color: #64748b;
          font-size: 10.5px;
          font-weight: 700;
        }

        .camera-mgmt-type {
          font-size: 10.5px;
          background: #e2e8f0;
          color: #334155;
          padding: 1px 6px;
          border-radius: 3px;
        }

        .camera-mgmt-meta {
          font-size: 11px;
          color: #64748b;
          display: flex;
          gap: 12px;
        }

        .camera-mgmt-actions {
          display: flex;
          gap: 6px;
          flex-shrink: 0;
        }

        .camera-editor-modal, .camera-view-modal {
          width: min(520px, calc(100vw - 32px));
          max-height: calc(100vh - 40px);
          overflow: auto;
          padding: 24px;
          border-radius: 16px;
          background: #fff;
          box-shadow: 0 24px 60px rgba(16,24,40,.25);
        }

        .camera-view-modal { width: min(920px, calc(100vw - 32px)); }
        .camera-view-modal > img { display: block; width: 100%; max-height: 70vh; object-fit: contain; background: #101828; border-radius: 10px; }

        .camera-editor-modal .modal-header, .camera-view-modal .modal-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 20px;
        }

        .camera-editor-modal .modal-header h2, .camera-view-modal .modal-header h2 { margin: 0; color: #101828; font-size: 20px; }
        .camera-editor-modal .modal-header p, .camera-view-modal .modal-header p { margin: 5px 0 0; color: #667085; font-size: 12px; }
        .camera-editor-modal .modal-close, .camera-view-modal .modal-close { border: 0; background: transparent; color: #667085; font-size: 25px; cursor: pointer; }

        .camera-form-label { display: block; margin: 0 0 15px; color: #344054; font-size: 12px; font-weight: 650; }
        .camera-form-label input, .camera-form-label select { display: block; width: 100%; margin-top: 6px; padding: 10px 11px; border: 1px solid #d0d5dd; border-radius: 8px; color: #101828; background: #fff; font: inherit; font-weight: 400; box-sizing: border-box; }
        .camera-form-hint { display: block; margin-top: 5px; color: #667085; font-size: 11px; font-weight: 400; }
        .camera-role-fieldset { display: flex; flex-wrap: wrap; gap: 16px; margin: 6px 0 14px; padding: 12px; border: 1px solid #eaecf0; border-radius: 9px; }
        .camera-role-fieldset legend { padding: 0 5px; color: #344054; font-size: 12px; font-weight: 650; }
        .camera-role-option { display: inline-flex; align-items: center; gap: 7px; color: #475467; font-size: 12px; }
        .camera-role-option input { accent-color: #4f46e5; }
        .camera-enabled-option { margin: 6px 0 14px; }
        .camera-editor-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 16px; }

        @media (max-width: 700px) {
          .camera-config-fields {
            grid-template-columns: 1fr;
          }
          .camera-management-toolbar { flex-direction: column; }
        }

        .camera-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
        }

        .camera-name {
          font-size: 14px;
          font-weight: 750;
          color: #101828;
        }

        .camera-responsibility {
          color: #667085;
          font-size: 12px;
          margin-top: 5px;
        }

        .connection-badge {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 5px 9px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 700;
        }

        .connection-badge.connected {
          color: #067647;
          background: #ecfdf3;
        }

        .connection-badge.configured {
          color: #175cd3;
          background: #eff8ff;
        }

        .connection-badge.disconnected {
          color: #b42318;
          background: #fef3f2;
        }

        .camera-details {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-top: 20px;
          padding-top: 16px;
          border-top: 1px solid #f2f4f7;
        }

        .detail-label {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: .5px;
          color: #98a2b3;
          font-weight: 700;
        }

        .detail-value {
          font-size: 12px;
          color: #344054;
          font-weight: 600;
          margin-top: 4px;
        }

        .table-card {
          background: white;
          border: 1px solid #eaecf0;
          border-radius: 12px;
          overflow: hidden;
        }

        .table-toolbar {
          padding: 16px;
          border-bottom: 1px solid #eaecf0;
          display: flex;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }

        .search-box {
          min-width: 260px;
          position: relative;
        }

        .search-box input {
          width: 100%;
          border: 1px solid #d0d5dd;
          border-radius: 8px;
          padding: 9px 12px 9px 34px;
          outline: none;
          font-size: 12px;
        }

        .search-box input:focus {
          border-color: #7f56d9;
          box-shadow: 0 0 0 3px #f4f3ff;
        }

        .search-icon {
          position: absolute;
          left: 12px;
          top: 8px;
          color: #98a2b3;
        }

        .filter-group {
          display: flex;
          gap: 5px;
          flex-wrap: wrap;
        }

        .filter-button {
          border: 1px solid #eaecf0;
          background: white;
          color: #667085;
          border-radius: 7px;
          padding: 7px 10px;
          font-size: 11px;
          font-weight: 600;
        }

        .filter-button.active {
          background: #eef2ff;
          color: #4338ca;
          border-color: #c7d2fe;
        }

        .table-wrapper {
          overflow-x: auto;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          min-width: 850px;
        }

        th {
          background: #f9fafb;
          color: #667085;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: .5px;
          text-align: left;
          padding: 12px 16px;
          font-weight: 700;
          border-bottom: 1px solid #eaecf0;
        }

        td {
          padding: 14px 16px;
          border-bottom: 1px solid #f2f4f7;
          color: #344054;
          font-size: 12px;
        }

        tr:last-child td {
          border-bottom: 0;
        }

        .employee-cell {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .avatar {
          width: 34px;
          height: 34px;
          border-radius: 9px;
          background: #eef2ff;
          color: #4338ca;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 750;
          font-size: 12px;
        }

        .employee-name {
          font-weight: 700;
          color: #101828;
        }

        .employee-id {
          color: #98a2b3;
          font-size: 10px;
          margin-top: 2px;
        }

        .status-badge {
          display: inline-flex;
          align-items: center;
          padding: 4px 8px;
          border-radius: 999px;
          font-size: 9px;
          font-weight: 750;
          letter-spacing: .2px;
        }

        .status-early {
          background: #ecfdf3;
          color: #067647;
        }

        .status-late {
          background: #fef3f2;
          color: #b42318;
        }

        .status-ontime {
          background: #eff8ff;
          color: #175cd3;
        }

        .status-inside {
          background: #f4f3ff;
          color: #6941c6;
        }

        .status-outside {
          background: #f2f4f7;
          color: #475467;
        }

        .status-absent {
          background: #fef3f2;
          color: #b42318;
        }

        .status-neutral {
          background: #f2f4f7;
          color: #475467;
        }

        .action-button {
          border: 0;
          background: transparent;
          color: #4f46e5;
          font-size: 11px;
          font-weight: 700;
        }

        .action-button:hover {
          text-decoration: underline;
        }

        .employee-card-actions {
          margin-top: 15px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }

        .delete-employee-button {
          border: 1px solid #fecdca;
          background: #fff5f4;
          color: #b42318;
          border-radius: 7px;
          padding: 7px 10px;
          font-size: 11px;
          font-weight: 700;
          transition: 0.2s ease;
        }

        .delete-employee-button:hover {
          background: #fee4e2;
          border-color: #fda29b;
        }

        .delete-employee-button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .history-summary {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-bottom: 18px;
        }

        .history-stat {
          flex: 1;
          min-width: 120px;
          background: #f9fafb;
          border: 1px solid #eaecf0;
          border-radius: 9px;
          padding: 10px 12px;
        }

        .history-stat-label {
          font-size: 9px;
          color: #98a2b3;
          text-transform: uppercase;
          letter-spacing: .5px;
          font-weight: 700;
        }

        .history-stat-value {
          margin-top: 4px;
          font-size: 14px;
          color: #101828;
          font-weight: 750;
        }

        .history-date-group {
          margin-bottom: 20px;
        }

        .history-date-heading {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 9px 11px;
          background: #f9fafb;
          border: 1px solid #eaecf0;
          border-radius: 8px;
          margin-bottom: 4px;
        }

        .history-date-title {
          color: #344054;
          font-size: 11px;
          font-weight: 750;
        }

        .history-date-count {
          color: #98a2b3;
          font-size: 10px;
          font-weight: 600;
        }

        .history-event-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 10px;
          border-bottom: 1px solid #f2f4f7;
        }

        .history-event-row:last-child {
          border-bottom: 0;
        }

        .history-event-left {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .history-event-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }

        .history-event-dot.in {
          background: #12b76a;
        }

        .history-event-dot.out {
          background: #f04438;
        }

        .history-event-time {
          font-size: 13px;
          color: #101828;
          font-weight: 700;
        }

        .history-event-label {
          font-size: 10px;
          color: #98a2b3;
          margin-top: 2px;
        }

        .history-event-badge {
          min-width: 42px;
          text-align: center;
          padding: 5px 8px;
          border-radius: 999px;
          font-size: 9px;
          font-weight: 750;
        }

        .history-event-badge.in {
          color: #067647;
          background: #ecfdf3;
        }

        .history-event-badge.out {
          color: #b42318;
          background: #fef3f2;
        }

        .empty-state {
          text-align: center;
          padding: 50px 20px;
          color: #98a2b3;
        }

        .empty-icon {
          font-size: 30px;
          margin-bottom: 10px;
        }

        .message {
          padding: 12px 14px;
          border-radius: 8px;
          font-size: 12px;
          margin-bottom: 16px;
        }

        .error-message {
          background: #fef3f2;
          color: #b42318;
          border: 1px solid #fecdca;
        }

        .success-message {
          background: #ecfdf3;
          color: #067647;
          border: 1px solid #abefc6;
        }

        .page-panel {
          background: white;
          border: 1px solid #eaecf0;
          border-radius: 12px;
          padding: 22px;
        }

        .employee-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 14px;
        }

        .employee-card {
          border: 1px solid #eaecf0;
          border-radius: 10px;
          padding: 16px;
          background: white;
        }

        .employee-card-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .employee-card-name {
          font-size: 14px;
          font-weight: 700;
          color: #101828;
        }

        .employee-card-id {
          font-size: 11px;
          color: #98a2b3;
          margin-top: 3px;
        }

        .employee-info {
          margin-top: 16px;
          display: grid;
          gap: 8px;
        }

        .info-row {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
        }

        .info-row span:first-child {
          color: #98a2b3;
        }

        .info-row span:last-child {
          color: #344054;
          font-weight: 600;
        }

        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(16,24,40,.55);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          z-index: 100;
        }

        .modal {
          background: white;
          width: min(940px, 100%);
          max-height: 85vh;
          overflow-y: auto;
          border-radius: 14px;
          box-shadow: 0 20px 60px rgba(16,24,40,.2);
        }

        .modal-header {
          padding: 20px;
          border-bottom: 1px solid #eaecf0;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
        }

        .modal-title {
          margin: 0;
          font-size: 17px;
          color: #101828;
        }

        .modal-subtitle {
          margin-top: 4px;
          color: #667085;
          font-size: 11px;
        }

        .close-button {
          border: 0;
          background: #f2f4f7;
          width: 30px;
          height: 30px;
          border-radius: 7px;
          color: #667085;
        }

        .modal-body {
          padding: 20px;
        }

        .event-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 13px 0;
          border-bottom: 1px solid #f2f4f7;
        }

        .event-row:last-child {
          border-bottom: 0;
        }

        .event-date {
          font-size: 11px;
          color: #667085;
        }

        .event-time {
          font-size: 13px;
          font-weight: 700;
          color: #101828;
          margin-top: 3px;
        }

        .event-in {
          color: #067647;
          background: #ecfdf3;
        }

        .event-out {
          color: #b42318;
          background: #fef3f2;
        }

        .event-type {
          padding: 5px 9px;
          border-radius: 999px;
          font-size: 9px;
          font-weight: 750;
        }

        .form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px;
        }

        .form-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .form-group.full {
          grid-column: 1 / -1;
        }

        .form-group label {
          color: #344054;
          font-size: 11px;
          font-weight: 650;
        }

        .form-group input {
          border: 1px solid #d0d5dd;
          border-radius: 8px;
          padding: 10px;
          outline: none;
          font-size: 12px;
        }

        .form-group input:focus {
          border-color: #7f56d9;
          box-shadow: 0 0 0 3px #f4f3ff;
        }

        .modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          padding: 16px 20px;
          border-top: 1px solid #eaecf0;
        }

        .secondary-button {
          border: 1px solid #d0d5dd;
          background: white;
          color: #344054;
          border-radius: 8px;
          padding: 10px 14px;
          font-size: 12px;
          font-weight: 650;
        }

        .enrollment-section {
          margin-top: 20px;
          padding-top: 20px;
          border-top: 1px solid #eaecf0;
        }

        .enrollment-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 12px;
        }

        .enrollment-title {
          font-size: 13px;
          font-weight: 750;
          color: #101828;
        }

        .enrollment-caption {
          margin-top: 4px;
          color: #667085;
          font-size: 11px;
          line-height: 1.5;
        }

        .capture-layout {
          display: grid;
          grid-template-columns: 148px 1fr 172px;
          gap: 16px;
          align-items: start;
        }

        .camera-preview {
          width: 100%;
          background: #101828;
          border-radius: 10px;
          overflow: hidden;
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .camera-preview video,
        .camera-preview img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          transform: scaleX(-1);
        }

        .enrollment-camera-select {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 10px;
          margin: 0 0 12px;
          color: #475467;
          font-size: 11px;
          font-weight: 650;
        }

        .enrollment-camera-select select {
          max-width: 260px;
          padding: 8px 10px;
          border: 1px solid #d0d5dd;
          border-radius: 8px;
          background: white;
          color: #344054;
          font-size: 11px;
        }

        .camera-placeholder {
          color: #98a2b3;
          font-size: 12px;
          text-align: center;
          padding: 20px;
        }

        .capture-controls {
          display: flex;
          gap: 8px;
          margin-top: 10px;
          flex-wrap: wrap;
        }

        .capture-button {
          border: 0;
          background: #4f46e5;
          color: white;
          border-radius: 8px;
          padding: 9px 13px;
          font-size: 11px;
          font-weight: 700;
        }

        .capture-button:hover {
          background: #4338ca;
        }

        .capture-button:disabled {
          opacity: .5;
          cursor: not-allowed;
        }

        .camera-start-button {
          border: 1px solid #d0d5dd;
          background: white;
          color: #344054;
          border-radius: 8px;
          padding: 9px 13px;
          font-size: 11px;
          font-weight: 700;
        }


        /* ---------- Guided face enrollment ---------- */
        .pose-guide {
          position: absolute;
          left: 50%;
          top: 50%;
          height: 94%;
          aspect-ratio: 3 / 4;
          transform: translate(-50%, -50%);
          border: 3px dashed #d0d5dd;
          border-radius: 50%;
          pointer-events: none;
          transition: border-color .15s ease, box-shadow .15s ease;
        }

        .pose-guide.pose-idle {
          border-color: rgba(208, 213, 221, .9);
        }

        .pose-guide.pose-bad {
          border-color: #f04438;
          box-shadow: 0 0 0 2px rgba(240, 68, 56, .25);
        }

        .pose-guide.pose-ok {
          border-color: #12b76a;
          box-shadow: 0 0 0 2px rgba(18, 183, 106, .3);
        }

        .pose-guide.pose-done {
          border-style: solid;
          border-color: #12b76a;
          box-shadow: 0 0 0 4px rgba(18, 183, 106, .4);
        }



        .pose-info {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          gap: 6px;
          padding: 12px 10px;
          border: 1.5px solid #e4e7ec;
          border-radius: 10px;
          background: #f9fafb;
          align-self: stretch;
          transition: border-color .15s ease, background .15s ease;
        }

        .pose-info-bad { border-color: #f04438; background: #fef3f2; }
        .pose-info-ok,
        .pose-info-done { border-color: #12b76a; background: #ecfdf3; }

        .pose-info-label {
          font-size: 10px;
          font-weight: 800;
          letter-spacing: .06em;
          text-transform: uppercase;
          color: #667085;
        }

        .pose-info-arrow {
          font-size: 40px;
          line-height: 1;
          font-weight: 700;
          color: #4f46e5;
        }

        .pose-info-name {
          font-size: 14px;
          font-weight: 800;
          color: #101828;
        }

        .pose-info-message {
          margin-top: auto;
          width: 100%;
          font-size: 11px;
          font-weight: 650;
          line-height: 1.35;
          padding: 8px;
          border-radius: 8px;
          color: #344054;
          background: #eaecf0;
        }

        .pose-info-message.pose-message-bad {
          color: white;
          background: #d92d20;
        }

        .pose-info-message.pose-message-ok,
        .pose-info-message.pose-message-done {
          color: white;
          background: #039855;
        }

        .pose-debug {
          margin-top: 6px;
          font-size: 10px;
          color: #667085;
          font-family: monospace;
        }

        .pose-debug-toggle {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 11px;
          color: #667085;
        }

        .pose-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
        }

        .pose-cell {
          position: relative;
          aspect-ratio: 1 / 1;
          border: 1.5px dashed #d0d5dd;
          border-radius: 8px;
          background: #f9fafb;
          padding: 0;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: default;
        }

        .pose-cell.current {
          border-color: #2017d9;
          background: #eef2ff;
        }

        .pose-cell.done {
          border: 1.5px solid #12b76a;
          cursor: pointer;
        }

        .pose-cell.skipped {
          cursor: pointer;
          opacity: .6;
        }

        .pose-cell img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          transform: scaleX(-1);
        }

        .pose-cell-arrow {
          font-size: 22px;
          color: #98a2b3;
        }

        .pose-cell.current .pose-cell-arrow {
          color: #4f46e5;
        }

        .pose-cell-label {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          font-size: 8px;
          font-weight: 700;
          text-align: center;
          padding: 2px 0;
          background: rgba(255, 255, 255, .85);
          color: #344054;
        }

        .capture-count {
          margin-top: 9px;
          font-size: 11px;
          color: #667085;
          font-weight: 650;
        }

        .photo-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 8px;
        }

        .photo-card {
          position: relative;
          border: 1px solid #eaecf0;
          border-radius: 8px;
          overflow: hidden;
          background: #f9fafb;
        }

        .photo-card img {
          width: 100%;
          aspect-ratio: 1 / 1;
          object-fit: cover;
          display: block;
        }

        .remove-photo {
          position: absolute;
          right: 5px;
          top: 5px;
          width: 24px;
          height: 24px;
          border: 0;
          border-radius: 50%;
          background: rgba(16, 24, 40, .78);
          color: white;
          font-size: 14px;
          line-height: 24px;
          padding: 0;
        }

        .photo-number {
          position: absolute;
          left: 5px;
          bottom: 5px;
          background: rgba(16, 24, 40, .75);
          color: white;
          border-radius: 5px;
          padding: 3px 6px;
          font-size: 9px;
          font-weight: 700;
        }

        .capture-help {
          border: 1px solid #eaecf0;
          background: #f9fafb;
          border-radius: 9px;
          padding: 12px;
          color: #667085;
          font-size: 10px;
          line-height: 1.6;
        }

        .capture-help strong {
          color: #344054;
        }

        @media (max-width: 900px) {
          .capture-layout {
            grid-template-columns: 1fr;
          }

          .pose-info {
            flex-direction: row;
            flex-wrap: wrap;
            justify-content: center;
            align-items: center;
          }

          .pose-info-arrow { font-size: 26px; }
          .pose-info-message { margin-top: 0; flex: 1 1 100%; }
        }

        @media (max-width: 700px) {
          .capture-layout {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 1100px) {
          .stats-grid {
            grid-template-columns: repeat(2, 1fr);
          }

          .employee-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }

        @media (max-width: 800px) {
          .sidebar {
            width: 70px;
            padding: 20px 10px;
          }

          .brand {
            justify-content: center;
            padding-left: 0;
            padding-right: 0;
          }

          .brand-text,
          .nav-title,
          .nav-label,
          .sidebar-footer {
            display: none;
          }

          .nav-item {
            justify-content: center;
          }

          .main {
            width: calc(100% - 70px);
            margin-left: 70px;
          }

          .content {
            padding: 20px;
          }

          .topbar {
            padding: 0 20px;
          }

          .camera-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 600px) {
          .stats-grid,
          .employee-grid {
            grid-template-columns: 1fr;
          }

          .page-heading {
            flex-direction: column;
            gap: 15px;
          }

          .form-grid {
            grid-template-columns: 1fr;
          }

          .form-group.full {
            grid-column: auto;
          }

          .system-status {
            display: none;
          }
        }

        .auth-role-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 12px;
          border-radius: 9999px;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.01em;
        }

        .auth-role-pill.admin {
          background: #eff8ff;
          color: #175cd3;
          border: 1px solid #b2ddff;
        }

        .auth-role-pill.hr {
          background: #ecfdf3;
          color: #067647;
          border: 1px solid #abefc6;
        }

        .logout-button {
          background: #ffffff;
          border: 1px solid #d0d5dd;
          color: #475467;
          border-radius: 8px;
          padding: 6px 12px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          transition: all 0.15s;
        }

        .logout-button:hover {
          background: #fee4e2;
          border-color: #fda29b;
          color: #d92d20;
        }

        .dept-scope-banner {
          background: #ffffff;
          border: 1px solid #eaecf0;
          border-left: 4px solid #2563eb;
          border-radius: 10px;
          padding: 14px 18px;
          margin-bottom: 20px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }

        .dept-scope-text {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 13px;
          color: #344054;
          flex-wrap: wrap;
        }

        .dept-scope-icon {
          font-size: 16px;
        }

        .dept-filter-select {
          background: #f8fafc;
          border: 1px solid #cbd5e1;
          border-radius: 6px;
          padding: 4px 8px;
          font-size: 12px;
          color: #0f172a;
          font-weight: 600;
          outline: none;
        }

        .filter-toolbar-card {
          background: #ffffff;
          border: 1px solid #eaecf0;
          border-radius: 12px;
          padding: 14px 18px;
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 12px;
          box-shadow: 0 1px 3px rgba(16, 24, 40, 0.04);
        }

        .filter-fields-row {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
          flex: 1;
        }

        .filter-select-box {
          background: #ffffff;
          border: 1px solid #d0d5dd;
          border-radius: 8px;
          padding: 8px 32px 8px 12px;
          font-size: 13px;
          color: #344054;
          font-weight: 500;
          outline: none;
          cursor: pointer;
          appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2364748b'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 10px center;
          background-size: 14px;
        }

        .filter-select-box:focus {
          border-color: #2563eb;
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
        }

        .card-tag-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          font-weight: 600;
          padding: 3px 8px;
          border-radius: 6px;
        }

        .card-tag-dept {
          background: #eff6ff;
          color: #1d4ed8;
          border: 1px solid #bfdbfe;
        }

        .card-tag-loc {
          background: #f0fdf4;
          color: #15803d;
          border: 1px solid #bbf7d0;
        }

        .table-dept-cell {
          font-size: 12px;
          font-weight: 600;
          color: #1d4ed8;
          background: #eff6ff;
          padding: 3px 8px;
          border-radius: 6px;
          display: inline-block;
          border: 1px solid #dbeafe;
          white-space: nowrap;
        }

        .table-loc-cell {
          font-size: 12px;
          font-weight: 500;
          color: #15803d;
          background: #f0fdf4;
          padding: 3px 8px;
          border-radius: 6px;
          display: inline-block;
          border: 1px solid #dcfce7;
          white-space: nowrap;
        }

        .clear-filters-btn {
          background: #f8fafc;
          border: 1px solid #d0d5dd;
          color: #64748b;
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s;
        }

        .clear-filters-btn:hover {
          background: #fee4e2;
          border-color: #fca5a5;
          color: #b91c1c;
        }
      `}</style>

      {/* Top Navbar matching Miracle Reference */}
      <header className="miracle-topbar">
        <div className="miracle-topbar-left">
          <div
            className="miracle-nav-brand"
            onClick={() => setActivePage("dashboard")}
            title="Miracle Software Systems — FaceAttend Enterprise"
          >
            <img
              src={miracleLogo}
              alt="Miracle Software Systems"
              className="miracle-navbar-logo"
            />
          </div>

          <button
            type="button"
            className="miracle-menu-toggle"
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label="Toggle navigation menu"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>

        </div>

        <div className="miracle-topbar-right">
          {auth?.role === "superior" ? (
            <div className="miracle-role-pill superior">
              Superior Console
            </div>
          ) : auth?.role === "admin" ? (
            <div className="miracle-role-pill admin">
              System Admin
            </div>
          ) : (
            <div className="miracle-role-pill hr">
              HR: {auth?.department || "General"}
            </div>
          )}

          <div className="miracle-system-status">
            <span className="miracle-status-dot"></span>
            System Online
          </div>

          {/* User Profile Area with Dropdown */}
          <div className="miracle-profile-wrapper">
            <div
              className="miracle-profile-trigger"
              onClick={() => setShowProfileDropdown((prev) => !prev)}
              title="Account Menu"
            >
              <span className="miracle-user-name">
                {auth?.username ? (auth.username.charAt(0).toUpperCase() + auth.username.slice(1)) : "Durga Mallesh Amuj..."}
              </span>
              <div className="miracle-avatar-circle">
                {(auth?.username || "D").charAt(0).toUpperCase()}
              </div>
            </div>

            {showProfileDropdown && (
              <div className="miracle-dropdown-menu">
                <div className="miracle-dropdown-arrow"></div>
                <div className="miracle-dropdown-header">
                  <div className="dropdown-user-title">
                    {auth?.username ? (auth.username.charAt(0).toUpperCase() + auth.username.slice(1)) : "Durga Mallesh Amuj..."}
                  </div>
                  <div className="dropdown-user-role">
                    {auth?.role === "superior"
                      ? "Superior Authority"
                      : auth?.role === "admin"
                      ? "System Administrator"
                      : `HR Officer • ${auth?.department || ""}`}
                  </div>
                </div>

                <div className="miracle-dropdown-divider"></div>

                <button
                  type="button"
                  className="miracle-dropdown-item"
                  onClick={() => {
                    setShowProfileDropdown(false);
                    setShowTourModal(true);
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                  </svg>
                  <span>Start Tour</span>
                </button>

                <button
                  type="button"
                  className="miracle-dropdown-item"
                  onClick={() => {
                    setShowProfileDropdown(false);
                    setShowProfileModal(true);
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                  </svg>
                  <span>Profile</span>
                </button>

                <button
                  type="button"
                  className="miracle-dropdown-item"
                  onClick={() => {
                    setShowProfileDropdown(false);
                    setPasswordStatus({ loading: false, error: "", success: "" });
                    setPasswordForm({ old_password: "", new_password: "", confirm_password: "" });
                    setShowPasswordModal(true);
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                  </svg>
                  <span>Reset Password</span>
                </button>

                <button
                  type="button"
                  className="miracle-dropdown-item"
                  onClick={() => {
                    setShowProfileDropdown(false);
                    if (activePage === "attendance") {
                      loadAttendanceByDate(selectedDate);
                      loadCameraStatus();
                    } else if (activePage === "admin_mgmt") {
                      loadAdminUsers();
                    } else if (activePage === "general_access") {
                      loadHrUsers();
                    } else if (activePage === "audit_logs") {
                      loadAuditLogs();
                    } else {
                      loadDashboardData();
                      loadCameraStatus();
                    }
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10"></polyline>
                    <polyline points="1 20 1 14 7 14"></polyline>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                  </svg>
                  <span>Refresh Data</span>
                </button>

                <div className="miracle-dropdown-divider"></div>

                <button
                  type="button"
                  className="miracle-dropdown-item logout"
                  onClick={() => {
                    setShowProfileDropdown(false);
                    handleLogout();
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                    <polyline points="16 17 21 12 16 7"></polyline>
                    <line x1="21" y1="12" x2="9" y2="12"></line>
                  </svg>
                  <span>Logout</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Body Layout: Sidebar + Main */}
      <div className="miracle-body-layout">
        {/* Dark Collapsible Sidebar matching Miracle Reference - strictly Dashboard and Attendance */}
        <aside className={`miracle-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <div className="miracle-sidebar-menu">
            <button
              type="button"
              className={`miracle-sidebar-item ${activePage === "dashboard" ? "active" : ""}`}
              onClick={() => setActivePage("dashboard")}
              title="Dashboard"
            >
              <span className="sidebar-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="9"></rect>
                  <rect x="14" y="3" width="7" height="5"></rect>
                  <rect x="14" y="12" width="7" height="9"></rect>
                  <rect x="3" y="16" width="7" height="5"></rect>
                </svg>
              </span>
              {!sidebarCollapsed && <span className="sidebar-label">Dashboard</span>}
            </button>

            <button
              type="button"
              className={`miracle-sidebar-item ${activePage === "attendance" ? "active" : ""}`}
              onClick={() => setActivePage("attendance")}
              title="Attendance"
            >
              <span className="sidebar-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                  <polyline points="9 16 11 18 15 14"></polyline>
                </svg>
              </span>
              {!sidebarCollapsed && <span className="sidebar-label">Attendance</span>}
            </button>

            <button
              type="button"
              className={`miracle-sidebar-item ${activePage === "employees" ? "active" : ""}`}
              onClick={() => setActivePage("employees")}
              title="Employees"
            >
              <span className="sidebar-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
              </span>
              {!sidebarCollapsed && <span className="sidebar-label">Employees</span>}
            </button>

            <button
              type="button"
              className="miracle-sidebar-item"
              onClick={() => {
                resetAddEmployeeState();
                setShowAddEmployee(true);
              }}
              title="Add Employee"
            >
              <span className="sidebar-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="8.5" cy="7" r="4"></circle>
                  <line x1="20" y1="8" x2="20" y2="14"></line>
                  <line x1="23" y1="11" x2="17" y2="11"></line>
                </svg>
              </span>
              {!sidebarCollapsed && <span className="sidebar-label">Add Employee</span>}
            </button>

            <button
              type="button"
              className="miracle-sidebar-item"
              onClick={() => {
                resetCameraDraft();
                setShowCameraEditor(true);
              }}
              title="Add Camera"
            >
              <span className="sidebar-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                  <circle cx="12" cy="13" r="4"></circle>
                </svg>
              </span>
              {!sidebarCollapsed && <span className="sidebar-label">Add Camera</span>}
            </button>

            <button
              type="button"
              className={`miracle-sidebar-item ${activePage === "general_access" ? "active" : ""}`}
              onClick={() => setActivePage("general_access")}
              title="General Access (HR)"
            >
              <span className="sidebar-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
              </span>
              {!sidebarCollapsed && <span className="sidebar-label">General Access (HR)</span>}
            </button>
          </div>

          <div className="miracle-sidebar-footer">
            {!sidebarCollapsed ? (
              <>
                <div className="sidebar-footer-role">
                  {auth?.role === "superior"
                    ? "Superior Authority"
                    : auth?.role === "admin"
                    ? "System Admin"
                    : `HR: ${auth?.department || ""}`}
                </div>
                <div className="sidebar-footer-version">
                  FaceAttend Enterprise • v7.0
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", fontSize: "10px", color: "#64748b" }}>v7.0</div>
            )}
          </div>
        </aside>

        {/* Main Content Area */}
        <main className={`miracle-main ${sidebarCollapsed ? "collapsed" : ""}`}>
          <div className="content">
            {/* Miracle Breadcrumb */}
            <div className="miracle-breadcrumb-bar">
              <span className="miracle-bc-home">HOME</span>
              <span className="miracle-bc-sep">›</span>
              <span className="miracle-bc-active">
                {activePage === "dashboard"
                  ? "DASHBOARD"
                  : activePage === "attendance"
                  ? "EMPLOYEE SEARCH & ATTENDANCE"
                  : activePage === "employees"
                  ? "EMPLOYEE DIRECTORY"
                  : activePage === "admin_mgmt"
                  ? "ADMIN ACCOUNTS"
                  : activePage === "audit_logs"
                  ? "ACTIVITY & AUDIT LOGS"
                  : activePage === "attendance_override"
                  ? "MANUAL ATTENDANCE CORRECTION"
                  : activePage === "general_access"
                  ? "GENERAL ACCESS (HR)"
                  : activePage.toUpperCase()}
              </span>
            </div>

            {/* Superior Authority subtabs */}
            {auth?.role === "superior" && (
              <div className="miracle-admin-subtabs">
                <button
                  type="button"
                  className={`miracle-subtab ${activePage === "admin_mgmt" ? "active" : ""}`}
                  onClick={() => setActivePage("admin_mgmt")}
                >
                  Admin Accounts
                </button>
                <button
                  type="button"
                  className={`miracle-subtab ${activePage === "audit_logs" ? "active" : ""}`}
                  onClick={() => setActivePage("audit_logs")}
                >
                  Audit Logs
                </button>
                <button
                  type="button"
                  className={`miracle-subtab ${activePage === "attendance_override" ? "active" : ""}`}
                  onClick={() => setActivePage("attendance_override")}
                >
                  Attendance Correction
                </button>
              </div>
            )}
          {activePage === "dashboard" && (
            <>
              {error && (
                <div className="message error-message">
                  {error}
                </div>
              )}

              <DashboardAnalyticsCharts
                totalEmployees={totalEmployees}
                presentToday={presentToday}
                lateToday={lateToday}
                insideNow={insideNow}
                employees={authorizedEmployees}
                attendance={authorizedAttendance}
              />

              <section className="section dashboard-camera-section">
                <div className="section-header">
                  <div>
                    <div className="section-title">
                      Camera Monitoring
                      <span className="miracle-title-line"></span>
                    </div>
                    <div className="section-caption">
                      Real-time camera previews and configured recognition streams
                    </div>
                  </div>
                </div>

                {cameraError && (
                  <div className="message error-message">
                    {cameraError}
                  </div>
                )}

                {cameraActionError && <div className="message error-message" role="alert">{cameraActionError}</div>}
                {cameraActionMessage && <div className="message success-message" role="status">{cameraActionMessage}</div>}
                {cameraLoading ? (
                  <div className="camera-empty">Loading cameras…</div>
                ) : cameras.length ? (
                  <div className="dashboard-camera-grid">
                    {cameras.map((camera) => (
                      <DashboardCameraCard
                        key={camera.id}
                        camera={camera}
                        onView={() => openCameraPreview(camera)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="camera-empty">No cameras configured yet. Add a webcam or IP camera using the Add Camera menu.</div>
                )}
              </section>

              <AttendanceTable
                employees={filteredEmployees}
                getAttendance={getAttendance}
                getStatus={getStatus}
                formatStatus={formatStatus}
                formatTime={formatTime}
                formatWorkedTime={formatWorkedTime}
                formatBreakTime={formatBreakTime}
                statusClass={statusClass}
                search={search}
                setSearch={setSearch}
                deptFilter={deptFilter}
                setDeptFilter={setDeptFilter}
                locationFilter={locationFilter}
                setLocationFilter={setLocationFilter}
                allDepartments={allDepartments}
                allLocations={allLocations}
                isHr={auth?.role === "hr"}
                hrDepartment={auth?.department}
                statusFilter={statusFilter}
                setStatusFilter={setStatusFilter}
                openEmployeeHistory={openEmployeeHistory}
                onViewDaily={(emp, rec) =>
                  setDailyViewEmployee({
                    employee: emp,
                    record: rec || getAttendance(emp.employee_id) || {},
                    date: selectedDate || new Date().toISOString().slice(0, 10),
                  })
                }
                loading={loading}
              />
            </>
          )}

          {activePage === "employees" && (
            <>
              <div className="page-heading">
                <div>
                  <h1 className="page-title">{auth?.role === "hr" ? "Department Employees" : "Employees"}</h1>
                  <p className="page-description">
                    {auth?.role === "hr"
                      ? `Managing authorized employee records for ${auth.department}.`
                      : "Manage employees registered across all departments in the attendance system."}
                  </p>
                </div>

                <button
                  className="primary-button"
                  onClick={() => {
                    const defaultDept = auth?.role === "hr" ? auth.department : (allDepartments[0] || "Software Services");
                    setEmployeeForm((prev) => ({
                      ...prev,
                      department: auth?.role === "hr" ? auth.department : (prev.department || defaultDept),
                      work_location: prev.work_location || "Miracle City (HQ)",
                    }));
                    setShowAddEmployee(true);
                  }}
                >
                  + Add Employee
                </button>
              </div>

              {/* 3-WAY FILTER TOOLBAR: Department, Employee Name/ID, Work Location */}
              <div className="filter-toolbar-card">
                <div className="filter-fields-row">
                  {/* Filter 1: Employee Name / ID */}
                  <div className="search-box" style={{ minWidth: "220px", flex: "1 1 220px" }}>
                    <span className="search-icon">⌕</span>
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search employee name or ID..."
                    />
                  </div>

                  {/* Filter 2: Department */}
                  {auth?.role === "hr" ? (
                    <div className="card-tag-badge card-tag-dept" style={{ padding: "8px 12px", fontSize: "13px" }}>
                      Dept: {auth.department}
                    </div>
                  ) : (
                    <select
                      className="filter-select-box"
                      value={deptFilter}
                      onChange={(e) => setDeptFilter(e.target.value)}
                    >
                      <option value="ALL">All Departments ({employees.length})</option>
                      {allDepartments.map((dept) => (
                        <option key={dept} value={dept}>
                          {dept}
                        </option>
                      ))}
                    </select>
                  )}

                  {/* Filter 3: Work Location */}
                  <select
                    className="filter-select-box"
                    value={locationFilter}
                    onChange={(e) => setLocationFilter(e.target.value)}
                  >
                    <option value="ALL">All Locations</option>
                    {allLocations.map((loc) => (
                      <option key={loc} value={loc}>
                        {loc}
                      </option>
                    ))}
                  </select>

                  {/* Clear Filters Button */}
                  {(search || deptFilter !== "ALL" || locationFilter !== "ALL") && (
                    <button
                      type="button"
                      className="clear-filters-btn"
                      onClick={() => {
                        setSearch("");
                        setDeptFilter("ALL");
                        setLocationFilter("ALL");
                      }}
                    >
                      Clear Filters
                    </button>
                  )}
                </div>

                <div style={{ fontSize: "12px", color: "#64748b", fontWeight: 600 }}>
                  Showing {directoryEmployees.length} of {authorizedEmployees.length} employees
                </div>
              </div>

              <div className="page-panel">
                <div className="employee-grid">
                  {directoryEmployees.length === 0 ? (
                    <div style={{ padding: "40px 20px", textAlign: "center", color: "#64748b", gridColumn: "1 / -1" }}>
                      No employees match the selected criteria (Name: "{search || "any"}", Dept: "{deptFilter}", Location: "{locationFilter}").
                    </div>
                  ) : (
                    directoryEmployees.map((employee) => {
                      const record = getAttendance(employee.employee_id);
                      const status = getStatus(record);
                      const isExpanded = expandedEmployeeId === employee.employee_id;

                      return (
                        <div
                          className="employee-card"
                          key={employee.employee_id}
                          style={{
                            transition: "all 0.2s ease",
                            border: isExpanded ? "1px solid #4f46e5" : "1px solid #eaecf0",
                            boxShadow: isExpanded ? "0 4px 12px rgba(79, 70, 229, 0.08)" : "none",
                          }}
                        >
                          <div className="employee-card-top" style={{ alignItems: "flex-start" }}>
                            <div className="employee-cell">
                              <div className="avatar">
                                {String(employee.employee_name || "E").charAt(0).toUpperCase()}
                              </div>

                              <div>
                                <div className="employee-card-name">
                                  {employee.employee_name}
                                </div>
                                <div className="employee-card-id">
                                  ID: {employee.employee_id}
                                </div>
                              </div>
                            </div>

                            <span className={`status-badge ${statusClass(status)}`}>
                              {formatStatus(status)}
                            </span>
                          </div>

                          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", margin: "8px 0 6px 0" }}>
                            <span className="card-tag-badge card-tag-dept">
                              {employee.department || "General"}
                            </span>
                            <span className="card-tag-badge card-tag-loc">
                              {employee.work_location || "Miracle City (HQ)"}
                            </span>
                            {employee.is_flexible_shift && (
                              <span style={{ fontSize: "11px", fontWeight: "600", padding: "2px 7px", borderRadius: "5px", background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0" }}>
                                Flexible Shift
                              </span>
                            )}
                          </div>

                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "10px", paddingTop: "8px", borderTop: "1px solid #f1f5f9" }}>
                            <span style={{ fontSize: "12px", color: "#64748b" }}>
                              {employee.is_flexible_shift
                                ? "Flexible (8h req)"
                                : `${employee.shift_start || "--"} - ${employee.shift_end || "--"}`}
                            </span>
                            <button
                              type="button"
                              className="secondary-button"
                              style={{ padding: "4px 9px", fontSize: "11.5px" }}
                              onClick={() => setExpandedEmployeeId(isExpanded ? null : employee.employee_id)}
                            >
                              {isExpanded ? "Hide Details" : "View Details"}
                            </button>
                          </div>

                          {isExpanded && (
                            <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px dashed #e2e8f0" }}>
                              <div className="employee-info" style={{ marginTop: 0 }}>
                                <div className="info-row">
                                  <span>Email</span>
                                  <span>{employee.email || "--"}</span>
                                </div>
                                {employee.designation && (
                                  <div className="info-row">
                                    <span>Designation</span>
                                    <span>{employee.designation}</span>
                                  </div>
                                )}
                                {employee.reports_to && (
                                  <div className="info-row">
                                    <span>Reports To</span>
                                    <span>{employee.reports_to}</span>
                                  </div>
                                )}
                                <div className="info-row">
                                  <span>First In</span>
                                  <span>{formatTime(record?.first_in)}</span>
                                </div>
                                <div className="info-row">
                                  <span>Worked</span>
                                  <span>{formatWorkedTime(record)}</span>
                                </div>
                              </div>

                              <div className="employee-card-actions" style={{ marginTop: "12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                                <button
                                  type="button"
                                  className="action-button"
                                  onClick={() => openEditShift(employee)}
                                >
                                  Edit Shift
                                </button>
                                <button
                                  type="button"
                                  className="action-button"
                                  onClick={() => openEmployeeHistory(employee)}
                                >
                                  View History
                                </button>
                                <button
                                  type="button"
                                  className="action-button"
                                  onClick={() => openReportChooser(employee)}
                                >
                                  Export Report
                                </button>
                                <button
                                  type="button"
                                  className="delete-employee-button"
                                  onClick={() => deleteEmployee(employee)}
                                  disabled={deletingEmployeeId === String(employee.employee_id)}
                                >
                                  {deletingEmployeeId === String(employee.employee_id) ? "Deleting..." : "Delete"}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {!employees.length && (
                  <div className="empty-state">
                    <div className="empty-icon">•</div>
                    No employees registered.
                  </div>
                )}
              </div>
            </>
          )}

          {activePage === "attendance" && (
            <div className="miracle-attendance-page">
              {dateAttendanceError && (
                <div className="message error-message" style={{ marginBottom: "16px" }}>
                  {dateAttendanceError}
                </div>
              )}

              <div className="miracle-attendance-layout">
                {/* Left Column: Vertically Scrollable Alphabetical Employee Cards */}
                <div className="miracle-employee-column">
                  <div className="miracle-column-header">
                    <div>
                      <h2 className="miracle-list-title">Employee Attendance</h2>
                      <p className="miracle-list-subtitle">
                        Showing attendance records for <strong>{selectedDateText || selectedDate}</strong>
                      </p>
                    </div>
                  </div>

                  <div className="miracle-cards-scroll-container">
                    {dateAttendanceLoading ? (
                      <div className="loading-state" style={{ background: "#ffffff", padding: "30px", borderRadius: "6px", textAlign: "center" }}>
                        Loading employee attendance records…
                      </div>
                    ) : sortedAttendanceEmployees.length === 0 ? (
                      <div className="empty-state" style={{ background: "#ffffff", padding: "40px 20px", borderRadius: "6px", textAlign: "center", border: "1px solid #e2e8f0" }}>
                        <div style={{ fontSize: "28px", color: "#94a3b8", marginBottom: "8px" }}>⊘</div>
                        <div style={{ fontWeight: "600", color: "#334155", marginBottom: "4px" }}>No employees match the selected criteria</div>
                        <p style={{ color: "#64748b", fontSize: "13px", margin: 0 }}>
                          Try clearing or adjusting search keywords, department, location, or status filters.
                        </p>
                      </div>
                    ) : (
                      sortedAttendanceEmployees.map((emp) => {
                        const rec = getAttendance(emp.employee_id) || {};
                        const st = getStatus(rec);
                        const initials = (emp.employee_name || "E")
                          .split(" ")
                          .filter(Boolean)
                          .map((n) => n[0])
                          .slice(0, 2)
                          .join("")
                          .toUpperCase();

                        return (
                          <div
                            key={emp.employee_id}
                            className="miracle-employee-card"
                          >
                            <div className="miracle-card-avatar">
                              {initials}
                            </div>

                            <div className="miracle-card-info">
                              <div className="miracle-card-name-row">
                                <span className="miracle-card-name">{emp.employee_name}</span>
                                <span className="miracle-card-sep">|</span>
                                <span className="miracle-card-login">
                                  {emp.login_id || emp.username || emp.employee_id}
                                </span>
                              </div>

                              <div className="miracle-card-dept-row">
                                <span>{emp.department || "General Department"}</span>
                                {emp.designation && (
                                  <span className="miracle-card-desig"> • {emp.designation}</span>
                                )}
                              </div>

                              <div className="miracle-card-shift-row">
                                <span className="miracle-card-shift-icon">
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <polyline points="12 6 12 12 16 14"></polyline>
                                  </svg>
                                </span>
                                <span>
                                  {emp.is_flexible_shift
                                    ? "Flexible Shift"
                                    : `Shift: ${emp.shift_start || "09:00"} – ${emp.shift_end || "17:00"}`}
                                </span>
                              </div>

                              <div className="miracle-card-badges-row">
                                <span className="miracle-pill miracle-pill-location">
                                  {emp.work_location || emp.location || "Miracle City (HQ)"}
                                </span>

                                {st && st !== "ABSENT" && st !== "OUTSIDE" && (
                                  <span className={`miracle-pill miracle-pill-status ${statusClass(st)}`}>
                                    {formatStatus(st)}
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="miracle-card-actions">
                              <button
                                type="button"
                                className="miracle-card-icon-btn btn-blue"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openEditShift(emp);
                                }}
                                title="Edit Shift"
                                aria-label={`Edit shift for ${emp.employee_name}`}
                              >
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
                                  <path d="m15 5 4 4"></path>
                                </svg>
                              </button>

                              <button
                                type="button"
                                className="miracle-card-icon-btn btn-blue"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openEmployeeHistory(emp);
                                }}
                                title="View History"
                                aria-label={`View attendance history for ${emp.employee_name}`}
                              >
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M12 8v4l3 3"></path>
                                  <path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"></path>
                                </svg>
                              </button>

                              <button
                                type="button"
                                className="miracle-card-icon-btn btn-blue"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openReportChooser(emp);
                                }}
                                title="Export Report"
                                aria-label={`Export report for ${emp.employee_name}`}
                              >
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                  <polyline points="14 2 14 8 20 8"></polyline>
                                  <line x1="16" y1="13" x2="8" y2="13"></line>
                                  <line x1="16" y1="17" x2="8" y2="17"></line>
                                  <polyline points="10 9 9 9 8 9"></polyline>
                                </svg>
                              </button>

                              <button
                                type="button"
                                className="miracle-card-icon-btn btn-delete"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteEmployee(emp);
                                }}
                                disabled={deletingEmployeeId === String(emp.employee_id)}
                                title="Delete"
                                aria-label={`Delete ${emp.employee_name}`}
                              >
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="3 6 5 6 21 6"></polyline>
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                  <line x1="10" y1="11" x2="10" y2="17"></line>
                                  <line x1="14" y1="11" x2="14" y2="17"></line>
                                </svg>
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Right Column: Filter By Card matching Miracle Reference */}
                <div className="miracle-filter-column">
                  <div className="miracle-filter-card">
                    {/* Search Field */}
                    <div className="miracle-filter-section">
                      <label className="miracle-filter-label">EMPLOYEE SEARCH</label>
                      <div className="miracle-search-input-group">
                        <input
                          type="text"
                          className="miracle-filter-input"
                          placeholder="Search by Name, Email or Mobile"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                        <button
                          type="button"
                          className="miracle-search-btn"
                          title="Search employees"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="8"></circle>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                          </svg>
                        </button>
                      </div>
                    </div>

                    <div className="miracle-filter-title">Filter By</div>

                    {/* Attendance Date */}
                    <div className="miracle-filter-section">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                        <label className="miracle-filter-label" style={{ margin: 0 }}>ATTENDANCE DATE</label>
                        <button
                          type="button"
                          className="miracle-today-link"
                          onClick={() => {
                            const todayStr = new Date().toISOString().slice(0, 10);
                            setSelectedDate(todayStr);
                            loadAttendanceByDate(todayStr);
                          }}
                        >
                          Today
                        </button>
                      </div>
                      <input
                        type="date"
                        className="miracle-filter-input"
                        value={selectedDate}
                        onChange={handleAttendanceDateChange}
                      />
                    </div>

                    {/* Department Filter */}
                    <div className="miracle-filter-section">
                      <label className="miracle-filter-label">DEPARTMENT</label>
                      {auth?.role === "hr" ? (
                        <div className="miracle-scoped-dept-display">
                          <span>{auth?.department || "Department Locked"}</span>
                          <span className="miracle-scope-badge">HR SCOPE</span>
                        </div>
                      ) : (
                        <select
                          className="miracle-filter-select"
                          value={deptFilter}
                          onChange={(e) => setDeptFilter(e.target.value)}
                        >
                          <option value="ALL">All Departments</option>
                          {allDepartments.map((d) => (
                            <option key={d} value={d}>{d}</option>
                          ))}
                        </select>
                      )}
                    </div>

                    {/* Work Location Filter */}
                    <div className="miracle-filter-section">
                      <label className="miracle-filter-label">WORK LOCATION</label>
                      <select
                        className="miracle-filter-select"
                        value={locationFilter}
                        onChange={(e) => setLocationFilter(e.target.value)}
                      >
                        <option value="ALL">All Work Locations</option>
                        {allLocations.map((loc) => (
                          <option key={loc} value={loc}>{loc}</option>
                        ))}
                      </select>
                    </div>

                    {/* Attendance Status Filter */}
                    <div className="miracle-filter-section">
                      <label className="miracle-filter-label">ATTENDANCE STATUS</label>
                      <select
                        className="miracle-filter-select"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                      >
                        <option value="ALL">All Statuses</option>
                        <option value="PRESENT">Present</option>
                        <option value="LATE">Late Arrival</option>
                        <option value="ABSENT">Absent</option>
                        <option value="HALF_DAY">Half Day</option>
                        <option value="INSIDE_NOW">Inside Now</option>
                      </select>
                    </div>

                    {/* Actions in Filter Card */}
                    <div className="miracle-filter-actions">
                      <button
                        type="button"
                        className="miracle-export-btn"
                        onClick={() => openReportChooser()}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: "7px" }}>
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                          <polyline points="7 10 12 15 17 10"></polyline>
                          <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        Export Attendance (.xlsx)
                      </button>

                      {(search || deptFilter !== "ALL" || locationFilter !== "ALL" || statusFilter !== "ALL") && (
                        <button
                          type="button"
                          className="miracle-reset-btn"
                          onClick={() => {
                            setSearch("");
                            if (auth?.role !== "hr") setDeptFilter("ALL");
                            setLocationFilter("ALL");
                            setStatusFilter("ALL");
                          }}
                        >
                          Clear Filters
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          {activePage === "admin_mgmt" && auth?.role === "superior" && (
            <>
              <div className="page-heading">
                <div>
                  <h1 className="page-title">Administrator Accounts</h1>
                  <p className="page-description">
                    Manually generate Admin credentials. The administrator will be required to change their password on initial login.
                  </p>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", alignItems: "start" }}>
                <div className="page-panel">
                  <h3 style={{ fontSize: "16px", fontWeight: "700", margin: "0 0 6px 0", color: "#0f172a" }}>
                    Generate Admin Credentials
                  </h3>
                  <p style={{ fontSize: "12.5px", color: "#64748b", margin: "0 0 16px 0" }}>
                    Create login credentials for a new system administrator.
                  </p>

                  {adminCreateStatus.error && (
                    <div className="message error-message">{adminCreateStatus.error}</div>
                  )}
                  {adminCreateStatus.success && (
                    <div className="message success-message">{adminCreateStatus.success}</div>
                  )}

                  <form onSubmit={handleCreateAdmin}>
                    <div className="form-group" style={{ marginBottom: "14px" }}>
                      <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                        Admin Username
                      </label>
                      <input
                        type="text"
                        required
                        className="input-text"
                        style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                        placeholder="e.g. admin_ops"
                        value={newAdminForm.username}
                        onChange={(e) => setNewAdminForm((p) => ({ ...p, username: e.target.value }))}
                        disabled={adminCreateStatus.loading}
                      />
                    </div>

                    <div className="form-group" style={{ marginBottom: "14px" }}>
                      <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                        Initial Password
                      </label>
                      <input
                        type="text"
                        required
                        className="input-text"
                        style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                        placeholder="Assign temporary password"
                        value={newAdminForm.password}
                        onChange={(e) => setNewAdminForm((p) => ({ ...p, password: e.target.value }))}
                        disabled={adminCreateStatus.loading}
                      />
                      <span style={{ fontSize: "11px", color: "#64748b", marginTop: "4px", display: "block" }}>
                        Admin must change this password after their first login.
                      </span>
                    </div>

                    <div className="form-group" style={{ marginBottom: "16px" }}>
                      <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                        Display Name (Optional)
                      </label>
                      <input
                        type="text"
                        className="input-text"
                        style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                        placeholder="e.g. Operations Admin"
                        value={newAdminForm.display_name}
                        onChange={(e) => setNewAdminForm((p) => ({ ...p, display_name: e.target.value }))}
                        disabled={adminCreateStatus.loading}
                      />
                    </div>

                    <button
                      type="submit"
                      className="primary-button"
                      disabled={adminCreateStatus.loading}
                    >
                      {adminCreateStatus.loading ? "Generating..." : "Generate Admin Credentials"}
                    </button>
                  </form>
                </div>

                <div className="page-panel">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                    <h3 style={{ fontSize: "16px", fontWeight: "700", margin: 0, color: "#0f172a" }}>
                      Authorized Administrators
                    </h3>
                    <button
                      type="button"
                      className="secondary-button"
                      style={{ padding: "4px 9px", fontSize: "11.5px" }}
                      onClick={loadAdminUsers}
                    >
                      Refresh
                    </button>
                  </div>

                  <div className="table-wrapper">
                    <table style={{ width: "100%" }}>
                      <thead>
                        <tr>
                          <th>Username</th>
                          <th>Display Name</th>
                          <th>Password Change</th>
                          <th>Role</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminLoading ? (
                          <tr><td colSpan="4" style={{ textAlign: "center", padding: "20px" }}>Loading administrators...</td></tr>
                        ) : adminList.filter((u) => u.role === "admin").length === 0 ? (
                          <tr><td colSpan="4" style={{ textAlign: "center", padding: "20px", color: "#64748b" }}>No admin accounts found.</td></tr>
                        ) : (
                          adminList.filter((u) => u.role === "admin").map((u) => (
                            <tr key={u.username}>
                              <td><strong>{u.username}</strong></td>
                              <td>{u.display_name || "--"}</td>
                              <td>
                                {u.must_change_password ? (
                                  <span style={{ fontSize: "11px", fontWeight: "600", padding: "2px 7px", borderRadius: "4px", background: "#fef3f2", color: "#b42318" }}>
                                    Required
                                  </span>
                                ) : (
                                  <span style={{ fontSize: "11px", fontWeight: "600", padding: "2px 7px", borderRadius: "4px", background: "#ecfdf3", color: "#027a48" }}>
                                    Completed
                                  </span>
                                )}
                              </td>
                              <td>
                                <span className="card-tag-badge card-tag-dept">Administrator</span>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}

          {activePage === "general_access" && (auth?.role === "admin" || auth?.role === "superior") && (
            <>
              <div className="page-heading">
                <div>
                  <h1 className="page-title">General Access — HR Credentials</h1>
                  <p className="page-description">
                    Assign and provision HR account credentials by department. HR accounts can access records only within their assigned department.
                  </p>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", alignItems: "start" }}>
                <div className="page-panel">
                  <h3 style={{ fontSize: "16px", fontWeight: "700", margin: "0 0 6px 0", color: "#0f172a" }}>
                    Provision HR Credentials
                  </h3>
                  <p style={{ fontSize: "12.5px", color: "#64748b", margin: "0 0 16px 0" }}>
                    Select an authorized department and generate HR credentials.
                  </p>

                  {hrCreateStatus.error && (
                    <div className="message error-message">{hrCreateStatus.error}</div>
                  )}
                  {hrCreateStatus.success && (
                    <div className="message success-message">{hrCreateStatus.success}</div>
                  )}

                  <form onSubmit={handleCreateHr}>
                    <div className="form-group" style={{ marginBottom: "14px" }}>
                      <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                        Department Scope
                      </label>
                      <select
                        required
                        className="select-dropdown"
                        style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                        value={newHrForm.department}
                        onChange={(e) => setNewHrForm((p) => ({ ...p, department: e.target.value }))}
                        disabled={hrCreateStatus.loading}
                      >
                        {allDepartments.map((dept) => (
                          <option key={dept} value={dept}>
                            {dept}
                          </option>
                        ))}
                      </select>
                      <span style={{ fontSize: "11px", color: "#15803d", marginTop: "4px", display: "block" }}>
                        HR will be strictly restricted to {newHrForm.department} records.
                      </span>
                    </div>

                    <div className="form-group" style={{ marginBottom: "14px" }}>
                      <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                        HR Username
                      </label>
                      <input
                        type="text"
                        required
                        className="input-text"
                        style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                        placeholder="e.g. hr_innovation"
                        value={newHrForm.username}
                        onChange={(e) => setNewHrForm((p) => ({ ...p, username: e.target.value }))}
                        disabled={hrCreateStatus.loading}
                      />
                    </div>

                    <div className="form-group" style={{ marginBottom: "14px" }}>
                      <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                        Initial Password
                      </label>
                      <input
                        type="text"
                        required
                        className="input-text"
                        style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                        placeholder="Assign password"
                        value={newHrForm.password}
                        onChange={(e) => setNewHrForm((p) => ({ ...p, password: e.target.value }))}
                        disabled={hrCreateStatus.loading}
                      />
                    </div>

                    <div className="form-group" style={{ marginBottom: "16px" }}>
                      <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                        Display Name (Optional)
                      </label>
                      <input
                        type="text"
                        className="input-text"
                        style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                        placeholder={`e.g. HR Manager (${newHrForm.department})`}
                        value={newHrForm.display_name}
                        onChange={(e) => setNewHrForm((p) => ({ ...p, display_name: e.target.value }))}
                        disabled={hrCreateStatus.loading}
                      />
                    </div>

                    <button
                      type="submit"
                      className="primary-button"
                      disabled={hrCreateStatus.loading}
                    >
                      {hrCreateStatus.loading ? "Saving..." : "Save HR Credentials"}
                    </button>
                  </form>
                </div>

                <div className="page-panel">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                    <h3 style={{ fontSize: "16px", fontWeight: "700", margin: 0, color: "#0f172a" }}>
                      Assigned HR Accounts
                    </h3>
                    <button
                      type="button"
                      className="secondary-button"
                      style={{ padding: "4px 9px", fontSize: "11.5px" }}
                      onClick={loadHrUsers}
                    >
                      Refresh
                    </button>
                  </div>

                  <div className="table-wrapper">
                    <table style={{ width: "100%" }}>
                      <thead>
                        <tr>
                          <th>Department</th>
                          <th>Username</th>
                          <th>Display Name</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hrLoading ? (
                          <tr><td colSpan="3" style={{ textAlign: "center", padding: "20px" }}>Loading HR accounts...</td></tr>
                        ) : hrList.length === 0 ? (
                          <tr><td colSpan="3" style={{ textAlign: "center", padding: "20px", color: "#64748b" }}>No HR accounts found.</td></tr>
                        ) : (
                          hrList.map((u) => (
                            <tr key={u.username}>
                              <td>
                                <span className="card-tag-badge card-tag-dept">{u.department}</span>
                              </td>
                              <td><strong>{u.username}</strong></td>
                              <td>{u.display_name || "--"}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}

          {activePage === "audit_logs" && auth?.role === "superior" && (
            <>
              <div className="page-heading">
                <div>
                  <h1 className="page-title">Activity & Audit Logs</h1>
                  <p className="page-description">
                    Complete immutable audit trail of administrator actions, manual attendance overrides, shift updates, and account creation.
                  </p>
                </div>

                <button
                  type="button"
                  className="secondary-button"
                  onClick={loadAuditLogs}
                  disabled={auditLoading}
                >
                  {auditLoading ? "Refreshing..." : "Refresh Logs"}
                </button>
              </div>

              <div className="filter-toolbar-card" style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                <div>
                  <label style={{ fontSize: "11px", fontWeight: "600", display: "block", color: "#64748b", marginBottom: "4px" }}>
                    Actor Role
                  </label>
                  <select
                    className="filter-select-box"
                    value={auditRoleFilter}
                    onChange={(e) => setAuditRoleFilter(e.target.value)}
                  >
                    <option value="ALL">All Roles</option>
                    <option value="SUPERIOR">Superior</option>
                    <option value="ADMIN">Admin</option>
                    <option value="HR">HR</option>
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: "11px", fontWeight: "600", display: "block", color: "#64748b", marginBottom: "4px" }}>
                    Action Type
                  </label>
                  <select
                    className="filter-select-box"
                    value={auditActionFilter}
                    onChange={(e) => setAuditActionFilter(e.target.value)}
                  >
                    <option value="ALL">All Action Types</option>
                    <option value="MANUAL_ATTENDANCE_CORRECTION">Manual Attendance Correction</option>
                    <option value="USER_CREATE">User Account Creation</option>
                    <option value="PASSWORD_CHANGE">Password Change</option>
                    <option value="SHIFT_UPDATE">Shift Update</option>
                    <option value="EMPLOYEE_DELETE">Employee Delete</option>
                    <option value="DEPARTMENT_UPDATE">Department Update</option>
                    <option value="LEAVE_RECORD">Leave Record Added</option>
                    <option value="LEAVE_DELETE">Leave Record Deleted</option>
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: "11px", fontWeight: "600", display: "block", color: "#64748b", marginBottom: "4px" }}>
                    Target Date
                  </label>
                  <input
                    type="date"
                    className="filter-select-box"
                    value={auditDateFilter}
                    onChange={(e) => setAuditDateFilter(e.target.value)}
                  />
                </div>

                {(auditRoleFilter !== "ALL" || auditActionFilter !== "ALL" || auditDateFilter) && (
                  <button
                    type="button"
                    className="clear-filters-btn"
                    style={{ alignSelf: "flex-end" }}
                    onClick={() => {
                      setAuditRoleFilter("ALL");
                      setAuditActionFilter("ALL");
                      setAuditDateFilter("");
                    }}
                  >
                    Reset Filters
                  </button>
                )}
              </div>

              <div className="table-card" style={{ marginTop: "16px" }}>
                <div className="table-wrapper">
                  <table style={{ width: "100%" }}>
                    <thead>
                      <tr>
                        <th>Timestamp</th>
                        <th>Actor</th>
                        <th>Action</th>
                        <th>Target</th>
                        <th>Details / Changes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditLoading ? (
                        <tr><td colSpan="5" style={{ textAlign: "center", padding: "30px" }}>Loading audit records...</td></tr>
                      ) : auditLogs.length === 0 ? (
                        <tr><td colSpan="5" style={{ textAlign: "center", padding: "30px", color: "#64748b" }}>No audit log records match the current filter.</td></tr>
                      ) : (
                        auditLogs.map((log) => (
                          <tr key={log.id}>
                            <td style={{ fontSize: "11.5px", color: "#64748b", whiteSpace: "nowrap" }}>
                              {log.timestamp}
                            </td>
                            <td>
                              <strong>{log.actor_username}</strong>{" "}
                              <span style={{ fontSize: "10.5px", fontWeight: "700", padding: "1px 6px", borderRadius: "4px", background: "#f1f5f9", color: "#475467" }}>
                                {log.actor_role.toUpperCase()}
                              </span>
                            </td>
                            <td>
                              <span style={{ fontSize: "11px", fontWeight: "650", padding: "2px 8px", borderRadius: "4px", background: log.action_type.includes("CORRECTION") ? "#fef3f2" : "#eff8ff", color: log.action_type.includes("CORRECTION") ? "#b42318" : "#175cd3" }}>
                                {log.action_type}
                              </span>
                            </td>
                            <td>
                              {log.target_employee_id ? `Employee: ${log.target_employee_id}` : log.target_date ? `Date: ${log.target_date}` : "--"}
                            </td>
                            <td style={{ fontSize: "12px", color: "#334155", maxWidth: "420px" }}>
                              {log.details}
                              {log.before_val && log.after_val && (
                                <div style={{ fontSize: "11px", color: "#64748b", marginTop: "3px" }}>
                                  Before: {log.before_val} | After: {log.after_val}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {activePage === "attendance_override" && auth?.role === "superior" && (
            <>
              <div className="page-heading">
                <div>
                  <h1 className="page-title">Manual Attendance Correction</h1>
                  <p className="page-description">
                    Superiors can correct or adjust any employee's attendance record, including marking present or absent when no biometric check-in occurred. Every change is logged with before/after audit records.
                  </p>
                </div>
              </div>

              <div style={{ maxWidth: "700px" }}>
                <div className="page-panel">
                  <h3 style={{ fontSize: "16px", fontWeight: "700", margin: "0 0 6px 0", color: "#0f172a" }}>
                    Attendance Adjustment Form
                  </h3>
                  <p style={{ fontSize: "12.5px", color: "#64748b", margin: "0 0 16px 0" }}>
                    Select the target employee, attendance date, corrected status, and provide the mandatory justification.
                  </p>

                  {overrideStatus.error && (
                    <div className="message error-message">{overrideStatus.error}</div>
                  )}
                  {overrideStatus.success && (
                    <div className="message success-message">{overrideStatus.success}</div>
                  )}

                  <form onSubmit={handleManualOverride}>
                    <div className="form-group" style={{ marginBottom: "14px" }}>
                      <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                        Employee
                      </label>
                      <select
                        required
                        className="select-dropdown"
                        style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                        value={overrideForm.employee_id}
                        onChange={(e) => setOverrideForm((p) => ({ ...p, employee_id: e.target.value }))}
                        disabled={overrideStatus.loading}
                      >
                        <option value="">Select Employee...</option>
                        {employees.map((emp) => (
                          <option key={emp.employee_id} value={emp.employee_id}>
                            {emp.employee_name} ({emp.employee_id}) — {emp.department || "General"}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "14px" }}>
                      <div className="form-group">
                        <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                          Attendance Date
                        </label>
                        <input
                          type="date"
                          required
                          className="input-text"
                          style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                          value={overrideForm.attendance_date}
                          onChange={(e) => setOverrideForm((p) => ({ ...p, attendance_date: e.target.value }))}
                          disabled={overrideStatus.loading}
                        />
                      </div>

                      <div className="form-group">
                        <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                          Attendance Status
                        </label>
                        <select
                          required
                          className="select-dropdown"
                          style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                          value={overrideForm.status}
                          onChange={(e) => setOverrideForm((p) => ({ ...p, status: e.target.value }))}
                          disabled={overrideStatus.loading}
                        >
                          <option value="FULL_DAY">Full Day (&gt; 7.5 hours)</option>
                          <option value="HALF_DAY">Half Day (4.0 to 7.5 hours)</option>
                          <option value="ABSENT">Absent (&lt; 4 hours / No check-in)</option>
                          <option value="LEAVE">Approved Leave</option>
                        </select>
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "14px" }}>
                      <div className="form-group">
                        <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                          First In (Optional)
                        </label>
                        <input
                          type="time"
                          className="input-text"
                          style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                          value={overrideForm.first_in}
                          onChange={(e) => setOverrideForm((p) => ({ ...p, first_in: e.target.value }))}
                          disabled={overrideStatus.loading}
                        />
                      </div>

                      <div className="form-group">
                        <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                          Last Out (Optional)
                        </label>
                        <input
                          type="time"
                          className="input-text"
                          style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                          value={overrideForm.last_out}
                          onChange={(e) => setOverrideForm((p) => ({ ...p, last_out: e.target.value }))}
                          disabled={overrideStatus.loading}
                        />
                      </div>

                      <div className="form-group">
                        <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                          Worked Minutes
                        </label>
                        <input
                          type="number"
                          min="0"
                          max="1440"
                          className="input-text"
                          style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                          value={overrideForm.worked_minutes}
                          onChange={(e) => setOverrideForm((p) => ({ ...p, worked_minutes: e.target.value }))}
                          disabled={overrideStatus.loading}
                        />
                      </div>
                    </div>

                    <div className="form-group" style={{ marginBottom: "16px" }}>
                      <label style={{ display: "block", fontSize: "12.5px", fontWeight: "600", marginBottom: "5px", color: "#334155" }}>
                        Reason for Manual Override (Mandatory Audit Trail Justification)
                      </label>
                      <textarea
                        required
                        rows="3"
                        className="input-text"
                        style={{ width: "100%", padding: "9px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", resize: "vertical" }}
                        placeholder="Provide reason for manual correction (e.g. Device connectivity disruption; confirmed by facility manager)"
                        value={overrideForm.reason}
                        onChange={(e) => setOverrideForm((p) => ({ ...p, reason: e.target.value }))}
                        disabled={overrideStatus.loading}
                      />
                    </div>

                    <button
                      type="submit"
                      className="primary-button"
                      disabled={overrideStatus.loading}
                    >
                      {overrideStatus.loading ? "Applying Correction..." : "Apply Manual Correction & Log to Audit"}
                    </button>
                  </form>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>

      {showCameraEditor && (
        <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && setShowCameraEditor(false)}>
          <div className="camera-management-modal">
            <div className="modal-header">
              <div>
                <h2>{cameraDraft.id ? `Edit Camera: ${cameraDraft.name}` : "Camera Management & Setup"}</h2>
                <p>Configure local webcams or network IP cameras and manage configured streams.</p>
              </div>
              <button type="button" className="modal-close" onClick={() => setShowCameraEditor(false)}>×</button>
            </div>

            <form className="camera-editor-form" onSubmit={saveCamera}>
              <div className="camera-form-title-row">
                <span className="camera-form-section-heading">
                  {cameraDraft.id ? "Edit Camera Settings" : "Add New Camera"}
                </span>
                {cameraDraft.id && (
                  <button
                    type="button"
                    className="camera-action-button"
                    onClick={() => resetCameraDraft()}
                  >
                    ← Add New Camera Instead
                  </button>
                )}
              </div>

              <div className="camera-config-grid">
                <label className="camera-form-label">Camera name
                  <input name="name" value={cameraDraft.name} onChange={handleCameraDraftChange} placeholder="Front entrance" required />
                </label>

                <label className="camera-form-label">Camera type
                  <select name="source_type" value={cameraDraft.source_type} onChange={(event) => setCameraDraft((previous) => ({ ...previous, source_type: event.target.value, source: event.target.value === "webcam" ? "0" : "" }))}>
                    <option value="webcam">Webcam / local device</option>
                    <option value="ip">IP / CC camera</option>
                  </select>
                </label>
              </div>

              <label className="camera-form-label">{cameraDraft.source_type === "webcam" ? "Device index or device path" : "Stream URL"}
                <input
                  name="source"
                  value={cameraDraft.source}
                  onChange={handleCameraDraftChange}
                  placeholder={cameraDraft.source_type === "webcam" ? "0 or /dev/video0" : "rtsp://camera-ip:554/stream"}
                  required={!cameraDraft.id}
                  autoComplete="off"
                  spellCheck="false"
                />
                {cameraDraft.id && <span className="camera-form-hint">Leave blank to keep the currently saved source.</span>}
              </label>

              <fieldset className="camera-role-fieldset">
                <legend>Assign camera to</legend>
                {["ENTRY", "EXIT", "ENROLLMENT"].map((role) => (
                  <label className="camera-role-option" key={role}>
                    <input type="checkbox" checked={cameraDraft.roles.includes(role)} onChange={() => toggleCameraRole(role)} />
                    {role === "ENTRY" ? "Entry" : role === "EXIT" ? "Exit" : "Enrollment"}
                  </label>
                ))}
              </fieldset>

              <label className="camera-role-option camera-enabled-option">
                <input type="checkbox" name="enabled" checked={cameraDraft.enabled} onChange={handleCameraDraftChange} />
                Camera enabled
              </label>

              {cameraActionError && <div className="message error-message" role="alert">{cameraActionError}</div>}
              {cameraActionMessage && <div className="message success-message" role="status">{cameraActionMessage}</div>}

              <div className="camera-editor-actions">
                <button type="button" className="camera-action-button" onClick={() => setShowCameraEditor(false)}>Close</button>
                <button type="submit" className="primary-button" disabled={cameraBusy}>{cameraBusy ? "Saving…" : cameraDraft.id ? "Save changes" : "Add camera"}</button>
              </div>
            </form>

            <div className="camera-configured-section">
              <div className="camera-configured-heading">
                <span className="camera-form-section-heading">Configured Cameras ({cameras.length})</span>
                <span className="camera-form-subheading">Manage, test connections, toggle or remove cameras</span>
              </div>

              {cameras.length === 0 ? (
                <div className="camera-empty-list">No cameras configured yet. Use the form above to add your first camera.</div>
              ) : (
                <div className="camera-management-list">
                  {cameras.map((camera) => (
                    <div key={camera.id} className={`camera-mgmt-item ${camera.enabled ? "" : "disabled"}`}>
                      <div className="camera-mgmt-info">
                        <div className="camera-mgmt-name-row">
                          <span className="camera-mgmt-name">{camera.name}</span>
                          <span className={`camera-mgmt-badge ${camera.enabled ? "enabled" : "disabled"}`}>
                            {camera.enabled ? "● ENABLED" : "○ DISABLED"}
                          </span>
                          <span className="camera-mgmt-type">
                            {camera.source_type === "webcam" ? "Webcam" : "IP Camera"}
                          </span>
                        </div>
                        <div className="camera-mgmt-meta">
                          <span><strong>Source:</strong> {camera.device || "--"}</span>
                          <span><strong>Purpose:</strong> {camera.roles?.length ? camera.roles.join(", ") : "None"}</span>
                        </div>
                      </div>
                      <div className="camera-mgmt-actions">
                        <button type="button" className="camera-action-button" onClick={() => openCameraPreview(camera)} disabled={!camera.enabled} title="View stream">View</button>
                        <button type="button" className="camera-action-button" onClick={() => testCamera(camera)} disabled={!camera.enabled} title="Test connection">Test</button>
                        <button type="button" className="camera-action-button" onClick={() => editCamera(camera)} title="Edit settings">Edit</button>
                        <button type="button" className="camera-action-button" onClick={() => toggleCameraEnabled(camera)} title={camera.enabled ? "Disable camera" : "Enable camera"}>
                          {camera.enabled ? "Disable" : "Enable"}
                        </button>
                        <button type="button" className="camera-action-button danger" onClick={() => deleteCamera(camera)} title="Delete camera">Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {viewCamera && (
        <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && closeCameraPreview()}>
          <div className="camera-view-modal">
            <div className="modal-header">
              <div>
                <h2>{viewCamera.name}</h2>
                <p>{viewCamera.source_type === "webcam" ? "Webcam" : "IP / CC camera"} · Live preview</p>
              </div>
              <button type="button" className="modal-close" onClick={closeCameraPreview}>×</button>
            </div>
            <img src={`${API_URL}/cameras/${viewCamera.id}/stream.mjpg?stream_id=${encodeURIComponent(viewCamera.streamId)}`} alt={`Live preview of ${viewCamera.name}`} />
          </div>
        </div>
      )}

      {showAddEmployee && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (
              event.target === event.currentTarget &&
              !enrollmentLoading
            ) {
              closeAddEmployee();
            }
          }}
        >
          <div className="modal">
            <div className="modal-header">
              <div>
                <h2 className="modal-title">Add Employee</h2>
                <div className="modal-subtitle">
                  Add employee details and capture face photos for recognition.
                </div>
              </div>

              <button
                className="close-button"
                onClick={closeAddEmployee}
                disabled={enrollmentLoading}
              >
                ×
              </button>
            </div>

            <form onSubmit={addEmployee}>
              <div className="modal-body">
                {formError && (
                  <div className="message error-message">
                    {formError}
                  </div>
                )}

                {formMessage && (
                  <div className="message success-message">
                    {formMessage}
                  </div>
                )}

                <div className="form-grid">
                  <div className="form-group">
                    <label>Employee ID</label>
                    <input
                      name="employee_id"
                      value={employeeForm.employee_id}
                      onChange={handleEmployeeFormChange}
                      placeholder="e.g. 6495"
                      required
                      disabled={enrollmentLoading}
                    />
                  </div>

                  <div className="form-group full">
                    <label>
                      Hubble Login ID <span style={{ fontWeight: 400, color: "#667085" }}>(optional)</span>
                    </label>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <input
                        name="login_id"
                        value={employeeForm.login_id}
                        onChange={handleEmployeeFormChange}
                        onKeyDown={handleHubbleLoginKeyDown}
                        onBlur={() => {
                          const trimmed = (employeeForm.login_id || "").trim();
                          if (trimmed && hubbleEmployee?.login_id?.toLowerCase() !== trimmed.toLowerCase() && !hubbleLoading) {
                            fetchHubbleEmployee(trimmed);
                          }
                        }}
                        placeholder="e.g. mbhasyam"
                        disabled={enrollmentLoading || hubbleLoading}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        onClick={() => fetchHubbleEmployee()}
                        disabled={enrollmentLoading || hubbleLoading || !employeeForm.login_id.trim()}
                        style={{
                          border: "1px solid #c7d2fe",
                          background: "#eef2ff",
                          color: "#4338ca",
                          borderRadius: "8px",
                          padding: "0 12px",
                          fontSize: "11px",
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          cursor: enrollmentLoading || hubbleLoading || !employeeForm.login_id.trim() ? "not-allowed" : "pointer",
                          opacity: enrollmentLoading || hubbleLoading || !employeeForm.login_id.trim() ? 0.6 : 1,
                        }}
                      >
                        {hubbleLoading ? "Fetching…" : "Fetch"}
                      </button>
                    </div>
                    {hubbleError && (
                      <div style={{ marginTop: "7px", color: "#b42318", fontSize: "11px", lineHeight: 1.4 }} role="alert">
                        {hubbleError}
                      </div>
                    )}
                    {hubbleEmployee && !hubbleError && (
                      <div style={{ marginTop: "7px", color: "#067647", fontSize: "11px" }}>
                        ✓ Mock Hubble details loaded successfully.
                      </div>
                    )}
                  </div>

                  <div className="form-group">
                    <label>Employee Name</label>
                    <input
                      name="employee_name"
                      value={employeeForm.employee_name}
                      onChange={handleEmployeeFormChange}
                      placeholder="Employee name"
                      required={!employeeForm.login_id.trim()}
                      disabled={enrollmentLoading}
                    />
                  </div>

                  <div className="form-group">
                    <label>Shift Start</label>
                    <input
                      type="time"
                      name="shift_start"
                      value={employeeForm.shift_start}
                      onChange={handleEmployeeFormChange}
                      required
                      disabled={enrollmentLoading}
                    />
                  </div>

                  <div className="form-group">
                    <label>Shift End</label>
                    <input
                      type="time"
                      name="shift_end"
                      value={employeeForm.shift_end}
                      onChange={handleEmployeeFormChange}
                      required
                      disabled={enrollmentLoading}
                    />
                  </div>

                  <div className="form-group">
                    <label>Department</label>
                    <select
                      name="department"
                      value={employeeForm.department || (auth?.role === "hr" ? auth.department : "Software Services")}
                      onChange={handleEmployeeFormChange}
                      disabled={enrollmentLoading || auth?.role === "hr"}
                      style={{
                        width: "100%",
                        padding: "10px 12px",
                        borderRadius: "8px",
                        border: "1px solid #d0d5dd",
                        background: auth?.role === "hr" ? "#f8fafc" : "white",
                        fontSize: "13px",
                      }}
                    >
                      {allDepartments.map((dept) => (
                        <option key={dept} value={dept}>
                          {dept}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Work Location</label>
                    <select
                      name="work_location"
                      value={employeeForm.work_location || "Miracle City (HQ)"}
                      onChange={handleEmployeeFormChange}
                      disabled={enrollmentLoading}
                      style={{
                        width: "100%",
                        padding: "10px 12px",
                        borderRadius: "8px",
                        border: "1px solid #d0d5dd",
                        background: "white",
                        fontSize: "13px",
                      }}
                    >
                      {allLocations.map((loc) => (
                        <option key={loc} value={loc}>
                          {loc}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group full">
                    <label>Email Address</label>
                    <input
                      type="email"
                      name="email"
                      value={employeeForm.email}
                      onChange={handleEmployeeFormChange}
                      placeholder="employee@company.com"
                      required={!employeeForm.login_id.trim()}
                      disabled={enrollmentLoading}
                    />
                  </div>
                </div>

                {employeeForm.login_id && (
                  <div
                    style={{
                      marginTop: "12px",
                      padding: "10px 12px",
                      borderRadius: "8px",
                      background: hubbleEmployee ? "#ecfdf3" : "#f4f3ff",
                      border: hubbleEmployee ? "1px solid #abefc6" : "1px solid #e9d7fe",
                      color: hubbleEmployee ? "#067647" : "#5925dc",
                      fontSize: "11px",
                      lineHeight: 1.5,
                    }}
                  >
                    {hubbleEmployee ? (
                      <>
                        <div style={{ fontWeight: 700, marginBottom: "6px" }}>Mock Hubble Employee Details</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "5px 14px", color: "#344054" }}>
                          <div><strong>Employee ID:</strong> {hubbleEmployee.employee_id || "--"}</div>
                          <div><strong>Login ID:</strong> {hubbleEmployee.login_id || "--"}</div>
                          <div><strong>Reporting Manager:</strong> {hubbleEmployee.reporting_manager || "--"}</div>
                          <div><strong>HR Contact:</strong> {hubbleEmployee.hr_contact || "--"}</div>
                          <div><strong>Department:</strong> {hubbleEmployee.department || "--"}</div>
                          <div><strong>Designation:</strong> {hubbleEmployee.designation || "--"}</div>
                          <div><strong>Team:</strong> {hubbleEmployee.team || "--"}</div>
                        </div>
                      </>
                    ) : (
                      <>Enter a Login ID and press <strong>Enter</strong> or click <strong>Fetch</strong> to load mock employee details. Sync to MongoDB occurs when you save this employee.</>
                    )}
                  </div>
                )}

                <div className="enrollment-section">
                  <div className="enrollment-header">
                    <div>
                      <div className="enrollment-title">
                        Face Enrollment
                      </div>
                      <div className="enrollment-caption">
                        Follow each angle on the guide. The photo is taken
                        automatically when the guide turns green. Keep only
                        the employee in the frame.
                      </div>
                    </div>

                    <div className="capture-count">
                      {capturedPhotos.length} / {POSE_STEPS.length} angles
                    </div>
                  </div>

                  <label className="enrollment-camera-select">
                    Enrollment camera
                    <select
                      value={enrollmentCameraId}
                      onChange={(event) => {
                        stopEnrollmentCamera();
                        setEnrollmentCameraId(event.target.value);
                      }}
                      disabled={Boolean(cameraStream) || enrollmentLoading}
                    >
                      <option value="">Use a browser webcam (default)</option>
                      {enrollmentCameras.map((camera) => (
                        <option key={camera.id} value={camera.id}>
                          {camera.name} · {camera.source_type === "webcam" ? "Webcam" : "IP / CC"}
                        </option>
                      ))}
                    </select>
                  </label>

                  {captureError && (
                    <div className="message error-message">
                      {captureError}
                    </div>
                  )}

                  <div className="capture-layout">
                    <div className={`pose-info pose-info-${cameraStream && currentStep ? poseState.status : "idle"}`}>
                      {!cameraStream ? (
                        <>
                          <div className="pose-info-label">Ready</div>
                          <div className="pose-info-arrow">●</div>
                          <div className="pose-info-name">9 angles</div>
                          <div className="pose-info-message">
                            Click “Start Camera”. Then follow each angle.
                            The photo is taken automatically.
                          </div>
                        </>
                      ) : currentStep ? (
                        <>
                          <div className="pose-info-label">
                            Step{" "}
                            {POSE_STEPS.findIndex(
                              (step) => step.id === currentStep.id
                            ) + 1}{" "}
                            / {POSE_STEPS.length}
                          </div>

                          <div className="pose-info-arrow">
                            {currentStep.arrow}
                          </div>

                          <div className="pose-info-name">
                            {currentStep.label}
                          </div>

                          <div
                            className={`pose-info-message pose-message-${poseState.status}`}
                          >
                            {poseState.message}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="pose-info-label">Done</div>
                          <div className="pose-info-arrow">✓</div>
                          <div className="pose-info-name">All angles</div>
                          <div className="pose-info-message pose-message-done">
                            Click “Save Employee &amp; Enroll Face”.
                          </div>
                        </>
                      )}
                    </div>

                    <div>
                      <div
                        className="camera-preview"
                        style={{ aspectRatio: videoAspect }}
                      >
                        {cameraStream ? (
                          <>
                            {cameraStream.cameraId ? (
                              <img
                                ref={cameraImageRef}
                                crossOrigin="anonymous"
                                alt="Selected enrollment camera preview"
                                onLoad={(event) => {
                                  const { naturalWidth, naturalHeight } = event.currentTarget;
                                  if (naturalWidth && naturalHeight) setVideoAspect(naturalWidth / naturalHeight);
                                }}
                                onError={() => setCaptureError("Unable to display this camera stream. Check its connection and try again.")}
                              />
                            ) : (
                              <video
                                ref={videoRef}
                                autoPlay
                                muted
                                playsInline
                                onLoadedMetadata={(event) => {
                                  const { videoWidth, videoHeight } = event.currentTarget;
                                  if (videoWidth && videoHeight) setVideoAspect(videoWidth / videoHeight);
                                }}
                              />
                            )}

                            {currentStep && (
                              <div
                                className={`pose-guide pose-${poseState.status}`}
                              />
                            )}
                          </>
                        ) : (
                          <div className="camera-placeholder">
                            Camera is not started.
                            <br />
                            Click “Start Camera” to begin.
                          </div>
                        )}
                      </div>

                      <canvas
                        ref={canvasRef}
                        style={{ display: "none" }}
                      />

                      {cameraStream && showPoseDebug && poseState.debug && (
                        <div className="pose-debug">
                          yaw {poseState.debug.yaw.toFixed(1)}° · pitch{" "}
                          {poseState.debug.pitch.toFixed(1)}° · cues{" "}
                          {poseState.debug.yawCue.toFixed(2)} /{" "}
                          {poseState.debug.pitchCue.toFixed(2)} · faces{" "}
                          {poseState.debug.faces}
                        </div>
                      )}

                      <div className="capture-controls">
                        {!cameraStream ? (
                          <button
                            type="button"
                            className="camera-start-button"
                            onClick={startEnrollmentCamera}
                            disabled={enrollmentLoading}
                          >
                            Start Camera
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="camera-start-button"
                              onClick={skipCurrentStep}
                              disabled={
                                enrollmentLoading ||
                                !currentStep ||
                                currentStep.id === "front"
                              }
                            >
                              Skip this angle
                            </button>

                            <button
                              type="button"
                              className="camera-start-button"
                              onClick={stopEnrollmentCamera}
                              disabled={enrollmentLoading}
                            >
                              Stop Camera
                            </button>

                            <label className="pose-debug-toggle">
                              <input
                                type="checkbox"
                                checked={showPoseDebug}
                                onChange={(event) =>
                                  setShowPoseDebug(event.target.checked)
                                }
                              />
                              Show angles
                            </label>
                          </>
                        )}
                      </div>
                    </div>

                    <div>
                      <div className="pose-grid">
                        {[0, 1, 2].flatMap((row) =>
                          [0, 1, 2].map((col) => {
                            const step = POSE_STEPS.find(
                              (item) => item.row === row && item.col === col
                            );

                            const photoIndex = capturedPhotos.findIndex(
                              (photo) => photo.poseId === step.id
                            );

                            const photo =
                              photoIndex >= 0 ? capturedPhotos[photoIndex] : null;

                            const skipped = skippedSteps.includes(step.id);
                            const isCurrent = currentStep?.id === step.id;

                            return (
                              <button
                                type="button"
                                key={step.id}
                                className={`pose-cell${isCurrent ? " current" : ""}${photo ? " done" : ""}${skipped ? " skipped" : ""}`}
                                disabled={enrollmentLoading || (!photo && !skipped)}
                                title={
                                  photo || skipped
                                    ? `Retake: ${step.label}`
                                    : step.label
                                }
                                onClick={() => {
                                  setSkippedSteps((previous) =>
                                    previous.filter((id) => id !== step.id)
                                  );

                                  if (photoIndex >= 0) {
                                    removeCapturedPhoto(photoIndex);
                                  }
                                }}
                              >
                                {photo ? (
                                  <img
                                    src={photo.previewUrl}
                                    alt={`${step.label} captured`}
                                  />
                                ) : (
                                  <span className="pose-cell-arrow">
                                    {step.arrow}
                                  </span>
                                )}

                                <span className="pose-cell-label">
                                  {photo ? "✓ " : skipped ? "skipped · " : ""}
                                  {step.label}
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>

                      <div className="capture-help">
                        Tap a captured angle to retake it. At least 5 angles
                        are required.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={closeAddEmployee}
                  disabled={enrollmentLoading}
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="primary-button"
                  disabled={
                    enrollmentLoading ||
                    capturedPhotos.length < 5
                  }
                >
                  {enrollmentLoading
                    ? "Enrolling Face..."
                    : "Save Employee & Enroll Face"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedEmployee && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeHistory();
            }
          }}
        >
          <div className="modal">
            <div className="modal-header">
              <div>
                <h2 className="modal-title">
                  {selectedEmployee.employee_name}
                </h2>

                <div className="modal-subtitle">
                  Employee ID: {selectedEmployee.employee_id}
                </div>
              </div>

              <button className="close-button" onClick={closeHistory}>
                ×
              </button>
            </div>

            <div className="modal-body">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
                <button type="button" className="secondary-button" onClick={() => changeHistoryMonth(-1)} disabled={historyLoading}>← Previous</button>
                <strong style={{ color: "#344054", fontSize: 16 }}>
                  {new Date(historyYear, historyMonth - 1, 1).toLocaleDateString("en", { month: "long", year: "numeric" })}
                </strong>
                <button type="button" className="secondary-button" onClick={() => changeHistoryMonth(1)} disabled={historyLoading}>Next →</button>
              </div>

              {historyError && <div className="message error-message" role="alert">{historyError}</div>}
              {historyLoading ? (
                <div className="empty-state">Loading monthly attendance…</div>
              ) : (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6, marginBottom: 6, textAlign: "center", color: "#667085", fontSize: 11, fontWeight: 700 }}>
                    {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((weekday) => <div key={weekday}>{weekday}</div>)}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6 }}>
                    {Array.from({ length: (new Date(historyYear, historyMonth - 1, 1).getDay() + 6) % 7 }, (_, index) => <div key={`blank-${index}`} />)}
                    {attendanceHistory.map((day) => {
                      const colors = {
                        FULL_DAY: ["#ecfdf3", "#067647", "#abefc6"],
                        HALF_DAY: ["#fffaeb", "#b54708", "#fedf89"],
                        LEAVE: ["#f4f3ff", "#5925dc", "#d9d6fe"],
                        ABSENT: ["#fef3f2", "#b42318", "#fecdca"],
                        WEEKEND: ["#f9fafb", "#667085", "#eaecf0"],
                      }[day.status] || ["#f9fafb", "#344054", "#eaecf0"];
                      const selected = selectedHistoryDay?.date === day.date;
                      return (
                        <button
                          type="button"
                          key={day.date}
                          onClick={() => setSelectedHistoryDay(day)}
                          aria-pressed={selected}
                          style={{ minHeight: 66, padding: "7px 4px", borderRadius: 8, border: `1px solid ${selected ? "#344054" : colors[2]}`, background: colors[0], color: colors[1], cursor: "pointer", outline: selected ? "2px solid #344054" : "none" }}
                        >
                          <div style={{ fontWeight: 700 }}>{day.day}</div>
                          <div style={{ fontSize: 10, marginTop: 4, lineHeight: 1.25 }}>{day.status.replaceAll("_", " ")}</div>
                          {day.worked_hours && day.worked_minutes > 0 && <div style={{ fontSize: 10, marginTop: 2 }}>{day.worked_hours}</div>}
                        </button>
                      );
                    })}
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12, margin: "14px 0", fontSize: 11, color: "#475467" }}>
                    {[["FULL_DAY", "Full day"], ["HALF_DAY", "Partial day"], ["LEAVE", "Leave"], ["ABSENT", "Absent"], ["WEEKEND", "Weekend"]].map(([status, label]) => (
                      <span key={status}><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 3, marginRight: 5, background: { FULL_DAY: "#12b76a", HALF_DAY: "#f79009", LEAVE: "#7a5af8", ABSENT: "#f04438", WEEKEND: "#98a2b3" }[status] }} />{label}</span>
                    ))}
                  </div>

                  {selectedHistoryDay && (
                    <section style={{ border: "1px solid #eaecf0", borderRadius: 10, padding: 16, background: "#fcfcfd" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
                        <div>
                          <strong style={{ fontSize: 15, color: "#101828" }}>
                            {new Date(`${selectedHistoryDay.date}T00:00:00`).toLocaleDateString("en", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                          </strong>
                          <div style={{ marginTop: 4, color: "#475467", fontSize: 13 }}>
                            Status: <strong>{selectedHistoryDay.status.replaceAll("_", " ")}</strong>
                          </div>
                          {selectedHistoryDay.status === "LEAVE" && (
                            <div style={{ marginTop: 6, color: "#5925dc", fontSize: 12 }}>
                              {selectedHistoryDay.leave_type}{selectedHistoryDay.reason ? ` — ${selectedHistoryDay.reason}` : ""}
                            </div>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {selectedHistoryDay.status === "LEAVE" ? (
                            <button type="button" className="secondary-button" onClick={removeSelectedDayLeave} disabled={leaveSaving}>
                              {leaveSaving ? "Saving…" : "Remove leave"}
                            </button>
                          ) : (
                            <button type="button" className="secondary-button" onClick={saveSelectedDayLeave} disabled={leaveSaving || selectedHistoryDay.status === "WEEKEND"}>
                              {leaveSaving ? "Saving…" : "Mark leave / edit"}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Summary Metrics */}
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginBottom: 14 }}>
                        <div style={{ background: "#ffffff", border: "1px solid #e4e7ec", borderRadius: 8, padding: "10px 12px" }}>
                          <div style={{ fontSize: 11, color: "#667085", textTransform: "uppercase", fontWeight: 600 }}>Total Worked</div>
                          <div style={{ fontSize: 16, fontWeight: 700, color: "#101828", marginTop: 2 }}>{selectedHistoryDay.worked_hours || "0h 0m"}</div>
                        </div>
                        <div style={{ background: "#ffffff", border: "1px solid #e4e7ec", borderRadius: 8, padding: "10px 12px" }}>
                          <div style={{ fontSize: 11, color: "#667085", textTransform: "uppercase", fontWeight: 600 }}>Break Duration</div>
                          <div style={{ fontSize: 16, fontWeight: 700, color: "#101828", marginTop: 2 }}>
                            {selectedHistoryDay.break_hours || (selectedHistoryDay.break_minutes ? formatMinutes(selectedHistoryDay.break_minutes) : "0m")}
                          </div>
                        </div>
                        <div style={{ background: "#ffffff", border: "1px solid #e4e7ec", borderRadius: 8, padding: "10px 12px" }}>
                          <div style={{ fontSize: 11, color: "#667085", textTransform: "uppercase", fontWeight: 600 }}>Sessions & Events</div>
                          <div style={{ fontSize: 16, fontWeight: 700, color: "#101828", marginTop: 2 }}>
                            {selectedHistoryDay.sessions?.length || selectedHistoryDay.session_count || 0} sessions · {selectedHistoryDay.events?.length || selectedHistoryDay.event_count || 0} events
                          </div>
                        </div>
                        <div style={{ background: "#ffffff", border: "1px solid #e4e7ec", borderRadius: 8, padding: "10px 12px" }}>
                          <div style={{ fontSize: 11, color: "#667085", textTransform: "uppercase", fontWeight: 600 }}>First In / Last Out</div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#101828", marginTop: 3 }}>
                            {formatTime(selectedHistoryDay.first_in)} — {formatTime(selectedHistoryDay.last_out)}
                          </div>
                        </div>
                      </div>

                      {/* Sessions Breakdown Table */}
                      {selectedHistoryDay.sessions && selectedHistoryDay.sessions.length > 0 ? (
                        <div style={{ marginBottom: 14 }}>
                          <div style={{ fontSize: 12, fontWeight: 750, color: "#344054", marginBottom: 6 }}>Sessions Breakdown</div>
                          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", background: "#ffffff", border: "1px solid #eaecf0", borderRadius: 6, overflow: "hidden" }}>
                            <thead>
                              <tr style={{ background: "#f8f9fa", borderBottom: "1px solid #eaecf0", textAlign: "left" }}>
                                <th style={{ padding: "7px 10px" }}>Session</th>
                                <th style={{ padding: "7px 10px" }}>Check In</th>
                                <th style={{ padding: "7px 10px" }}>Check Out</th>
                                <th style={{ padding: "7px 10px" }}>Worked Duration</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedHistoryDay.sessions.map((sess, sIdx) => (
                                <tr key={sIdx} style={{ borderBottom: "1px solid #f2f4f7" }}>
                                  <td style={{ padding: "7px 10px", fontWeight: 600 }}>Session {sess.session_number || (sIdx + 1)}</td>
                                  <td style={{ padding: "7px 10px", color: "#067647" }}>{formatTime(sess.check_in)}</td>
                                  <td style={{ padding: "7px 10px", color: "#175cd3" }}>{formatTime(sess.check_out)}</td>
                                  <td style={{ padding: "7px 10px", fontWeight: 600 }}>{sess.worked_hours || (sess.worked_minutes ? formatMinutes(sess.worked_minutes) : "--")}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : null}

                      {/* Raw Events */}
                      {selectedHistoryDay.events?.length > 0 && (
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 750, color: "#344054", marginBottom: 6 }}>Events Log</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                            {selectedHistoryDay.events.map((event, index) => (
                              <span key={`${event.id || index}-${event.event_time}`} style={{ borderRadius: 6, padding: "5px 8px", background: event.event_type === "IN" ? "#ecfdf3" : "#eff8ff", color: event.event_type === "IN" ? "#067647" : "#175cd3", fontSize: 11, fontWeight: 650, border: "1px solid", borderColor: event.event_type === "IN" ? "#abefc6" : "#b2ddff" }}>
                                {event.event_type} · {formatTime(event.event_time)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </section>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Daily Attendance Details Modal (View action on Attendance dashboard) */}
      {dailyViewEmployee && (
        <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && setDailyViewEmployee(null)}>
          <div className="modal" style={{ maxWidth: 640 }}>
            <div className="modal-header">
              <div>
                <h2 className="modal-title">Attendance Details</h2>
                <div className="modal-subtitle">
                  {dailyViewEmployee.employee.employee_name} · ID: {dailyViewEmployee.employee.employee_id} · {dailyViewEmployee.date}
                </div>
              </div>
              <button type="button" className="close-button" onClick={() => setDailyViewEmployee(null)}>×</button>
            </div>
            <div className="modal-body">
              {/* Daily metrics cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginBottom: 16 }}>
                <div style={{ background: "#f8f9fa", border: "1px solid #eaecf0", borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: "#667085", textTransform: "uppercase", fontWeight: 600 }}>Total Worked</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#101828", marginTop: 4 }}>
                    {formatWorkedTime(dailyViewEmployee.record)}
                  </div>
                </div>
                <div style={{ background: "#f8f9fa", border: "1px solid #eaecf0", borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: "#667085", textTransform: "uppercase", fontWeight: 600 }}>Break Duration</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#101828", marginTop: 4 }}>
                    {formatBreakTime(dailyViewEmployee.record)}
                  </div>
                </div>
                <div style={{ background: "#f8f9fa", border: "1px solid #eaecf0", borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: "#667085", textTransform: "uppercase", fontWeight: 600 }}>Sessions</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#101828", marginTop: 4 }}>
                    {dailyViewEmployee.record.session_count ?? dailyViewEmployee.record.sessions?.length ?? 0}
                  </div>
                </div>
                <div style={{ background: "#f8f9fa", border: "1px solid #eaecf0", borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: "#667085", textTransform: "uppercase", fontWeight: 600 }}>Status</div>
                  <div style={{ marginTop: 4 }}>
                    <span className={`status-badge ${statusClass(getStatus(dailyViewEmployee.record))}`}>
                      {formatStatus(getStatus(dailyViewEmployee.record))}
                    </span>
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div style={{ background: "#ffffff", border: "1px solid #eaecf0", borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 12, color: "#667085" }}>First Check-In</div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#067647", marginTop: 2 }}>
                    {formatTime(dailyViewEmployee.record.first_in)}
                  </div>
                </div>
                <div style={{ background: "#ffffff", border: "1px solid #eaecf0", borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 12, color: "#667085" }}>Last Check-Out</div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#175cd3", marginTop: 2 }}>
                    {formatTime(dailyViewEmployee.record.last_out)}
                  </div>
                </div>
              </div>

              {/* Sessions Breakdown */}
              {dailyViewEmployee.record.sessions && dailyViewEmployee.record.sessions.length > 0 ? (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#344054", marginBottom: 8 }}>Work Sessions</div>
                  <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", border: "1px solid #eaecf0", borderRadius: 6, overflow: "hidden" }}>
                    <thead>
                      <tr style={{ background: "#f8f9fa", borderBottom: "1px solid #eaecf0", textAlign: "left" }}>
                        <th style={{ padding: "8px 10px" }}>Session</th>
                        <th style={{ padding: "8px 10px" }}>In Time</th>
                        <th style={{ padding: "8px 10px" }}>Out Time</th>
                        <th style={{ padding: "8px 10px" }}>Worked Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dailyViewEmployee.record.sessions.map((sess, idx) => (
                        <tr key={idx} style={{ borderBottom: "1px solid #f2f4f7" }}>
                          <td style={{ padding: "8px 10px", fontWeight: 600 }}>Session {sess.session_number || (idx + 1)}</td>
                          <td style={{ padding: "8px 10px", color: "#067647" }}>{formatTime(sess.check_in)}</td>
                          <td style={{ padding: "8px 10px", color: "#175cd3" }}>{formatTime(sess.check_out)}</td>
                          <td style={{ padding: "8px 10px", fontWeight: 600 }}>{sess.worked_hours || (sess.worked_minutes ? formatMinutes(sess.worked_minutes) : "--")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ padding: "12px", background: "#f8f9fa", borderRadius: 8, fontSize: 13, color: "#667085", marginBottom: 16, textAlign: "center" }}>
                  {dailyViewEmployee.record.first_in ? "In-progress session or single event recorded." : "No attendance recorded for this date."}
                </div>
              )}

              {/* Raw Events */}
              {dailyViewEmployee.record.events && dailyViewEmployee.record.events.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#344054", marginBottom: 8 }}>Today's Check Events</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {dailyViewEmployee.record.events.map((ev, idx) => (
                      <span key={idx} style={{ borderRadius: 6, padding: "5px 8px", background: ev.event_type === "IN" ? "#ecfdf3" : "#eff8ff", color: ev.event_type === "IN" ? "#067647" : "#175cd3", fontSize: 11, fontWeight: 650, border: "1px solid", borderColor: ev.event_type === "IN" ? "#abefc6" : "#b2ddff" }}>
                        {ev.event_type} · {formatTime(ev.event_time)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer" style={{ justifyContent: "space-between" }}>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  const emp = dailyViewEmployee.employee;
                  setDailyViewEmployee(null);
                  openEmployeeHistory(emp);
                }}
              >
                View Full Monthly History
              </button>
              <button type="button" className="primary-button" onClick={() => setDailyViewEmployee(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Password Change Modal */}
      {showPasswordModal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !auth?.must_change_password && !passwordStatus.loading) {
              setShowPasswordModal(false);
            }
          }}
        >
          <div className="modal" style={{ maxWidth: 440 }}>
            <div className="modal-header">
              <div>
                <h2 className="modal-title">Change Password</h2>
                <div className="modal-subtitle">
                  {auth?.must_change_password
                    ? "Initial login: You must update your password before continuing."
                    : `Update account password for ${auth?.username}.`}
                </div>
              </div>
              {!auth?.must_change_password && (
                <button
                  type="button"
                  className="close-button"
                  onClick={() => setShowPasswordModal(false)}
                  disabled={passwordStatus.loading}
                >
                  ×
                </button>
              )}
            </div>
            <form onSubmit={handlePasswordChange}>
              <div className="modal-body">
                {passwordStatus.error && (
                  <div className="message error-message" role="alert">
                    {passwordStatus.error}
                  </div>
                )}
                {passwordStatus.success && (
                  <div className="message success-message" role="status">
                    Password updated successfully.
                  </div>
                )}
                <div className="form-group" style={{ marginBottom: 14 }}>
                  <label>Current Password</label>
                  <input
                    type="password"
                    required
                    value={passwordForm.current_password}
                    onChange={(e) =>
                      setPasswordForm((prev) => ({ ...prev, current_password: e.target.value }))
                    }
                    disabled={passwordStatus.loading}
                    placeholder="Enter current password"
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 14 }}>
                  <label>New Password</label>
                  <input
                    type="password"
                    required
                    value={passwordForm.new_password}
                    onChange={(e) =>
                      setPasswordForm((prev) => ({ ...prev, new_password: e.target.value }))
                    }
                    disabled={passwordStatus.loading}
                    placeholder="Enter new password (min 6 characters)"
                  />
                </div>
                <div className="form-group">
                  <label>Confirm New Password</label>
                  <input
                    type="password"
                    required
                    value={passwordForm.confirm_password}
                    onChange={(e) =>
                      setPasswordForm((prev) => ({ ...prev, confirm_password: e.target.value }))
                    }
                    disabled={passwordStatus.loading}
                    placeholder="Confirm new password"
                  />
                </div>
              </div>
              <div className="modal-footer" style={{ justifyContent: auth?.must_change_password ? "flex-end" : "space-between" }}>
                {!auth?.must_change_password && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setShowPasswordModal(false)}
                    disabled={passwordStatus.loading}
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="submit"
                  className="primary-button"
                  disabled={passwordStatus.loading}
                >
                  {passwordStatus.loading ? "Updating…" : "Update Password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Shift Modal */}
      {editingEmployee && (
        <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && !editShiftLoading && setEditingEmployee(null)}>
          <form className="modal" onSubmit={saveEmployeeShift}>
            <div className="modal-header">
              <div>
                <h2 className="modal-title">Edit Shift Schedule</h2>
                <div className="modal-subtitle">{editingEmployee.employee_name} · ID: {editingEmployee.employee_id} · {editingEmployee.designation || "Employee"}</div>
              </div>
              <button type="button" className="close-button" onClick={() => setEditingEmployee(null)} disabled={editShiftLoading}>×</button>
            </div>
            <div className="modal-body">
              {editShiftError && <div className="message error-message" role="alert">{editShiftError}</div>}
              
              <div style={{ marginBottom: 16, padding: "12px 14px", background: "#f8f9fa", border: "1px solid #eaecf0", borderRadius: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontWeight: 650, color: "#101828", fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(editShiftForm.is_flexible_shift)}
                    onChange={(event) => setEditShiftForm((prev) => ({ ...prev, is_flexible_shift: event.target.checked }))}
                    disabled={editShiftLoading}
                    style={{ width: 17, height: 17, cursor: "pointer" }}
                  />
                  Flexible Shift (8 Working Hours Required)
                </label>
                <div style={{ fontSize: 12, color: "#667085", marginTop: 6, lineHeight: 1.4 }}>
                  {editShiftForm.is_flexible_shift
                    ? "Employee is authorized for flexible working hours. They may fulfill their required 8 hours at flexible times without fixed start/end arrival penalties."
                    : "Standard fixed shift with scheduled start and end times. Arrival status and scheduled shift boundaries apply."}
                </div>
              </div>

              {!editShiftForm.is_flexible_shift && (
                <div className="form-grid">
                  <div className="form-group">
                    <label>Shift Start Time</label>
                    <input type="time" required value={editShiftForm.shift_start} onChange={(event) => setEditShiftForm((previous) => ({ ...previous, shift_start: event.target.value }))} disabled={editShiftLoading} />
                  </div>
                  <div className="form-group">
                    <label>Shift End Time</label>
                    <input type="time" required value={editShiftForm.shift_end} onChange={(event) => setEditShiftForm((previous) => ({ ...previous, shift_end: event.target.value }))} disabled={editShiftLoading} />
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary-button" onClick={() => setEditingEmployee(null)} disabled={editShiftLoading}>Cancel</button>
              <button type="submit" className="primary-button" disabled={editShiftLoading}>{editShiftLoading ? "Saving…" : "Save Shift"}</button>
            </div>
          </form>
        </div>
      )}

      {/* Export Attendance Modal */}
      {reportChooser && (
        <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && !reportDownloading && setReportChooser(null)}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <div>
                <h2 className="modal-title">Export Attendance Report</h2>
                <div className="modal-subtitle">
                  {reportChooser.employee ? `${reportChooser.employee.employee_name} · ID: ${reportChooser.employee.employee_id}` : "All Authorized Employees"}
                </div>
              </div>
              <button type="button" className="close-button" onClick={() => setReportChooser(null)} disabled={reportDownloading}>×</button>
            </div>
            <div className="modal-body">
              {reportError && <div className="message error-message" role="alert">{reportError}</div>}
              
              <div className="form-group" style={{ marginBottom: 14 }}>
                <label>Report Period</label>
                <select
                  value={reportPeriod}
                  onChange={(e) => setReportPeriod(e.target.value)}
                  disabled={reportDownloading}
                  className="filter-select-box"
                  style={{ width: "100%", height: 38 }}
                >
                  <option value="day">Day (Single Day)</option>
                  <option value="week">Week (Monday – Sunday)</option>
                  <option value="month">Month (Calendar Month)</option>
                  <option value="custom">Custom Date Range</option>
                </select>
              </div>

              {reportPeriod === "custom" ? (
                <div className="form-grid" style={{ marginBottom: 14 }}>
                  <div className="form-group">
                    <label>Start Date</label>
                    <input
                      type="date"
                      required
                      value={reportStartDate}
                      onChange={(e) => setReportStartDate(e.target.value)}
                      disabled={reportDownloading}
                    />
                  </div>
                  <div className="form-group">
                    <label>End Date</label>
                    <input
                      type="date"
                      required
                      value={reportEndDate}
                      onChange={(e) => setReportEndDate(e.target.value)}
                      disabled={reportDownloading}
                    />
                  </div>
                </div>
              ) : (
                <div className="form-group" style={{ marginBottom: 14 }}>
                  <label>
                    {reportPeriod === "day"
                      ? "Select Date"
                      : reportPeriod === "week"
                      ? "Select Date in Target Week"
                      : "Select Date in Target Month"}
                  </label>
                  <input
                    type="date"
                    required
                    value={reportDate}
                    onChange={(e) => setReportDate(e.target.value)}
                    disabled={reportDownloading}
                  />
                </div>
              )}

              <p style={{ color: "#667085", fontSize: 12, lineHeight: 1.5, margin: 0 }}>
                {reportPeriod === "day" && "Generates XLSX report for the chosen day with session events and working durations."}
                {reportPeriod === "week" && "Generates XLSX report covering the Monday through Sunday interval for the chosen date."}
                {reportPeriod === "month" && "Generates XLSX report covering the entire calendar month for the chosen date."}
                {reportPeriod === "custom" && "Generates XLSX report for the exact specified date range with daily summaries and break durations."}
              </p>
            </div>
            <div className="modal-footer" style={{ justifyContent: "space-between" }}>
              <button type="button" className="secondary-button" onClick={() => setReportChooser(null)} disabled={reportDownloading}>Cancel</button>
              <button
                type="button"
                className="primary-button"
                onClick={downloadAttendanceReport}
                disabled={reportDownloading || (reportPeriod === "custom" ? (!reportStartDate || !reportEndDate) : !reportDate)}
              >
                {reportDownloading ? "Generating XLSX…" : "Download Report"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 4. Employee Action Popup Modal matching Requirement 4 */}
      {actionEmployee && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setActionEmployee(null);
          }}
        >
          <div className="action-popup-card">
            <div className="action-popup-header">
              <div className="action-popup-user">
                <div className="action-popup-avatar">
                  {(actionEmployee.employee_name || "E")
                    .split(" ")
                    .filter(Boolean)
                    .map((n) => n[0])
                    .slice(0, 2)
                    .join("")
                    .toUpperCase()}
                </div>
                <div>
                  <h3 className="action-popup-name">{actionEmployee.employee_name}</h3>
                  <div className="action-popup-meta">
                    {actionEmployee.department || "General"} • ID: {actionEmployee.employee_id}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="action-popup-close"
                onClick={() => setActionEmployee(null)}
                title="Close"
              >
                ×
              </button>
            </div>

            <div className="action-popup-body">
              <p className="action-popup-prompt">Select an operation for this employee:</p>

              <div className="action-options-list">
                {/* 1. Edit Shift */}
                <button
                  type="button"
                  className="action-option-btn"
                  onClick={() => {
                    const emp = actionEmployee;
                    setActionEmployee(null);
                    openEditShift(emp);
                  }}
                >
                  <div className="action-option-icon icon-shift">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
                      <path d="m15 5 4 4"></path>
                    </svg>
                  </div>
                  <div className="action-option-details">
                    <div className="action-option-title">Edit Shift</div>
                  </div>
                </button>

                {/* 2. View History */}
                <button
                  type="button"
                  className="action-option-btn"
                  onClick={() => {
                    const emp = actionEmployee;
                    setActionEmployee(null);
                    openEmployeeHistory(emp);
                  }}
                >
                  <div className="action-option-icon icon-history">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 8v4l3 3"></path>
                      <path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"></path>
                    </svg>
                  </div>
                  <div className="action-option-details">
                    <div className="action-option-title">View History</div>
                  </div>
                </button>

                {/* 3. Export Report */}
                <button
                  type="button"
                  className="action-option-btn"
                  onClick={() => {
                    const emp = actionEmployee;
                    setActionEmployee(null);
                    openReportChooser(emp);
                  }}
                >
                  <div className="action-option-icon icon-report">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <polyline points="14 2 14 8 20 8"></polyline>
                      <line x1="16" y1="13" x2="8" y2="13"></line>
                      <line x1="16" y1="17" x2="8" y2="17"></line>
                      <polyline points="10 9 9 9 8 9"></polyline>
                    </svg>
                  </div>
                  <div className="action-option-details">
                    <div className="action-option-title">Export Report</div>
                  </div>
                </button>

                {/* 4. Delete Employee */}
                <button
                  type="button"
                  className="action-option-btn danger"
                  onClick={() => {
                    const emp = actionEmployee;
                    setActionEmployee(null);
                    deleteEmployee(emp);
                  }}
                >
                  <div className="action-option-icon icon-delete">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                      <line x1="10" y1="11" x2="10" y2="17"></line>
                      <line x1="14" y1="11" x2="14" y2="17"></line>
                    </svg>
                  </div>
                  <div className="action-option-details">
                    <div className="action-option-title" style={{ color: "#dc2626" }}>Delete</div>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* User Profile Modal */}
      {showProfileModal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowProfileModal(false);
          }}
        >
          <div className="action-popup-card">
            <div className="action-popup-header">
              <div className="action-popup-user">
                <div className="action-popup-avatar">
                  {(auth?.username || "U").charAt(0).toUpperCase()}
                </div>
                <div>
                  <h3 className="action-popup-name">User Profile</h3>
                  <div className="action-popup-meta">Miracle FaceAttend Enterprise</div>
                </div>
              </div>
              <button
                type="button"
                className="action-popup-close"
                onClick={() => setShowProfileModal(false)}
              >
                ×
              </button>
            </div>

            <div className="action-popup-body">
              <div style={{ display: "flex", flexDirection: "column", gap: "14px", fontSize: "13px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                  <span style={{ color: "#64748b" }}>Username</span>
                  <strong style={{ color: "#1e293b" }}>{auth?.username || "--"}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                  <span style={{ color: "#64748b" }}>Role</span>
                  <span className={`miracle-role-pill ${auth?.role || "hr"}`}>
                    {auth?.role === "superior" ? "Superior Authority" : auth?.role === "admin" ? "System Admin" : "HR Officer"}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                  <span style={{ color: "#64748b" }}>Department</span>
                  <strong style={{ color: "#1e293b" }}>{auth?.department || "Global (All Departments)"}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                  <span style={{ color: "#64748b" }}>System Status</span>
                  <span style={{ color: "#10b981", fontWeight: "600" }}>Active • Authenticated</span>
                </div>
              </div>

              <div style={{ marginTop: "22px", display: "flex", gap: "10px" }}>
                <button
                  type="button"
                  className="primary-button"
                  style={{ width: "100%" }}
                  onClick={() => setShowProfileModal(false)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Guided Tour Modal */}
      {showTourModal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowTourModal(false);
          }}
        >
          <div className="action-popup-card" style={{ maxWidth: "520px" }}>
            <div className="action-popup-header">
              <div>
                <h3 className="action-popup-name">FaceAttend Tour & Navigation</h3>
                <div className="action-popup-meta">Miracle Employee Interface Reference</div>
              </div>
              <button
                type="button"
                className="action-popup-close"
                onClick={() => setShowTourModal(false)}
              >
                ×
              </button>
            </div>

            <div className="action-popup-body" style={{ fontSize: "13px", lineHeight: "1.6", color: "#334155" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                  <div style={{ background: "#e0f2fe", color: "#0284c7", width: "26px", height: "26px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "700", flexShrink: 0 }}>1</div>
                  <div>
                    <strong style={{ color: "#0f172a" }}>Top Navigation Bar:</strong> Clean white navbar with Miracle branding, menu collapse toggle, Hubble quick shortcuts, and the user profile dropdown for Password Reset and Sign Out.
                  </div>
                </div>

                <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                  <div style={{ background: "#e0f2fe", color: "#0284c7", width: "26px", height: "26px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "700", flexShrink: 0 }}>2</div>
                  <div>
                    <strong style={{ color: "#0f172a" }}>Sidebar:</strong> Dedicated navigation focusing on <em>Dashboard</em> and <em>Attendance</em> with smooth expand/collapse capability.
                  </div>
                </div>

                <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                  <div style={{ background: "#e0f2fe", color: "#0284c7", width: "26px", height: "26px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "700", flexShrink: 0 }}>3</div>
                  <div>
                    <strong style={{ color: "#0f172a" }}>Attendance & Employee Cards:</strong> Vertically scrollable employee list sorted alphabetically A-Z with shift, status, and punch badges alongside the quick Filter By panel.
                  </div>
                </div>

                <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                  <div style={{ background: "#e0f2fe", color: "#0284c7", width: "26px", height: "26px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "700", flexShrink: 0 }}>4</div>
                  <div>
                    <strong style={{ color: "#0f172a" }}>Quick Employee Actions:</strong> Simply click on any employee card to open the quick action popup for <em>Edit Shift</em>, <em>View History</em>, or <em>Export Report</em>.
                  </div>
                </div>
              </div>

              <div style={{ marginTop: "24px", display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setShowTourModal(false)}
                >
                  Got It
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardAnalyticsCharts({
  totalEmployees = 0,
  presentToday = 0,
  lateToday = 0,
  insideNow = 0,
  employees = [],
  attendance = [],
}) {
  const onTimeToday = Math.max(0, presentToday - lateToday);
  const absentToday = Math.max(0, totalEmployees - presentToday);
  const attendanceRate = totalEmployees > 0 ? Math.round((presentToday / totalEmployees) * 100) : 0;

  // Donut chart calculations: circle with r=45 has circumference ~282.743
  const r = 45;
  const circumference = 2 * Math.PI * r;

  const slices = [
    { label: "On Time", count: onTimeToday, color: "var(--miracle-medium-blue, #2368A0)", dot: "#2368A0" },
    { label: "Late Arrival", count: lateToday, color: "var(--miracle-red, #EF4048)", dot: "#EF4048" },
    { label: "Absent", count: absentToday, color: "var(--miracle-dark-grey, #8C8C8C)", dot: "#8C8C8C" },
  ];

  let cumulativeOffset = 0;
  const sliceElements = totalEmployees > 0
    ? slices.map((slice) => {
        const fraction = totalEmployees > 0 ? slice.count / totalEmployees : 0;
        const strokeDash = fraction * circumference;
        const offset = -cumulativeOffset;
        cumulativeOffset += strokeDash;
        return (
          <circle
            key={slice.label}
            cx="60"
            cy="60"
            r={r}
            fill="transparent"
            stroke={slice.color}
            strokeWidth="14"
            strokeDasharray={`${strokeDash} ${circumference - strokeDash}`}
            strokeDashoffset={offset}
            strokeLinecap="butt"
            style={{ transition: "stroke-dasharray 0.4s ease, stroke-dashoffset 0.4s ease" }}
          />
        );
      })
    : null;

  // Department distribution
  const deptStats = useMemo(() => {
    const map = {};
    employees.forEach((emp) => {
      const dept = emp.department || "General";
      if (!map[dept]) map[dept] = { total: 0, present: 0 };
      map[dept].total += 1;
    });

    attendance.forEach((rec) => {
      const emp = employees.find((e) => String(e.employee_id) === String(rec.employee_id));
      if (emp) {
        const dept = emp.department || "General";
        const isPresent =
          String(rec.current_state || "").toUpperCase() === "INSIDE" ||
          (rec.first_in && rec.first_in !== "--" && rec.first_in !== "");
        if (isPresent && map[dept]) {
          map[dept].present += 1;
        }
      }
    });

    return Object.entries(map).map(([name, data]) => ({
      name,
      total: data.total,
      present: data.present,
    }));
  }, [employees, attendance]);

  return (
    <div className="dashboard-charts-grid">
      {/* 1. Donut Chart Card */}
      <div className="chart-card">
        <div className="chart-card-header">
          <h3 className="chart-card-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--miracle-medium-blue, #2368A0)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.21 15.89A10 10 0 1 1 8 2.83"></path>
              <path d="M22 12A10 10 0 0 0 12 2v10z"></path>
            </svg>
            Attendance Breakdown
          </h3>
          <span className="chart-card-badge">
            {totalEmployees > 0 ? `${attendanceRate}% Present` : "No Records"}
          </span>
        </div>

        {totalEmployees === 0 ? (
          <div className="chart-empty-state">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--miracle-dark-grey, #8C8C8C)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: "8px" }}>
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <div style={{ fontSize: "13px", fontWeight: "600", color: "var(--miracle-black, #232527)" }}>No Attendance Data</div>
            <div style={{ fontSize: "11px", color: "var(--miracle-dark-grey, #8C8C8C)", marginTop: "4px" }}>Add employees to begin tracking real-time status.</div>
          </div>
        ) : (
          <div className="donut-chart-container">
            <div className="donut-svg-wrapper">
              <svg width="140" height="140" viewBox="0 0 120 120" style={{ transform: "rotate(-90deg)" }}>
                {/* Background track */}
                <circle
                  cx="60"
                  cy="60"
                  r={r}
                  fill="transparent"
                  stroke="#f1f5f9"
                  strokeWidth="14"
                />
                {sliceElements}
              </svg>
              <div className="donut-center-info">
                <span className="donut-center-pct">{attendanceRate}%</span>
                <span className="donut-center-lbl">Attended</span>
              </div>
            </div>

            <div className="donut-legend-list">
              <div className="donut-legend-item">
                <div className="donut-legend-left">
                  <span className="donut-legend-dot" style={{ background: "var(--miracle-medium-blue, #2368A0)" }}></span>
                  <span>On-Time</span>
                </div>
                <div className="donut-legend-right">
                  <span className="donut-legend-val">{onTimeToday}</span>
                  <span className="donut-legend-pct">
                    ({totalEmployees > 0 ? Math.round((onTimeToday / totalEmployees) * 100) : 0}%)
                  </span>
                </div>
              </div>

              <div className="donut-legend-item">
                <div className="donut-legend-left">
                  <span className="donut-legend-dot" style={{ background: "var(--miracle-red, #EF4048)" }}></span>
                  <span>Late Arrival</span>
                </div>
                <div className="donut-legend-right">
                  <span className="donut-legend-val">{lateToday}</span>
                  <span className="donut-legend-pct">
                    ({totalEmployees > 0 ? Math.round((lateToday / totalEmployees) * 100) : 0}%)
                  </span>
                </div>
              </div>

              <div className="donut-legend-item">
                <div className="donut-legend-left">
                  <span className="donut-legend-dot" style={{ background: "var(--miracle-dark-grey, #8C8C8C)" }}></span>
                  <span>Absent</span>
                </div>
                <div className="donut-legend-right">
                  <span className="donut-legend-val">{absentToday}</span>
                  <span className="donut-legend-pct">
                    ({totalEmployees > 0 ? Math.round((absentToday / totalEmployees) * 100) : 0}%)
                  </span>
                </div>
              </div>

              <div className="donut-legend-item" style={{ paddingTop: "6px", borderTop: "1px dashed #e2e8f0" }}>
                <div className="donut-legend-left" style={{ fontWeight: 600 }}>
                  <span className="donut-legend-dot" style={{ background: "var(--miracle-dark-blue, #0D416B)" }}></span>
                  <span>Total Staff</span>
                </div>
                <div className="donut-legend-right">
                  <span className="donut-legend-val" style={{ color: "var(--miracle-dark-blue, #0D416B)" }}>{totalEmployees}</span>
                  <span className="donut-legend-pct">100%</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 2. Metrics Bar Chart Card */}
      <div className="chart-card">
        <div className="chart-card-header">
          <h3 className="chart-card-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--miracle-light-blue, #00AAE7)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="20" x2="18" y2="10"></line>
              <line x1="12" y1="20" x2="12" y2="4"></line>
              <line x1="6" y1="20" x2="6" y2="14"></line>
            </svg>
            Workforce Presence & Distribution
          </h3>
          <span className="chart-card-badge">Live Status</span>
        </div>

        {totalEmployees === 0 ? (
          <div className="chart-empty-state">
            <div style={{ fontSize: "13px", fontWeight: "600", color: "var(--miracle-black, #232527)" }}>No Employee Data Available</div>
            <div style={{ fontSize: "11px", color: "var(--miracle-dark-grey, #8C8C8C)", marginTop: "4px" }}>Database returned 0 employees for your department/scope.</div>
          </div>
        ) : (
          <>
            <div className="metrics-bar-list">
              {/* Total Workforce */}
              <div className="metric-bar-item">
                <div className="metric-bar-header">
                  <span className="metric-bar-label">
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--miracle-dark-blue, #0D416B)", display: "inline-block" }}></span>
                    Total Workforce
                  </span>
                  <div className="metric-bar-counts">
                    <span className="metric-bar-num">{totalEmployees}</span>
                    <span className="metric-bar-pct">Active Roster</span>
                  </div>
                </div>
                <div className="metric-bar-track">
                  <div className="metric-bar-fill" style={{ width: "100%", background: "var(--miracle-dark-blue, #0D416B)" }}></div>
                </div>
              </div>

              {/* Present Today */}
              <div className="metric-bar-item">
                <div className="metric-bar-header">
                  <span className="metric-bar-label">
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--miracle-light-blue, #00AAE7)", display: "inline-block" }}></span>
                    Present Today
                  </span>
                  <div className="metric-bar-counts">
                    <span className="metric-bar-num">{presentToday}</span>
                    <span className="metric-bar-pct">
                      {totalEmployees > 0 ? Math.round((presentToday / totalEmployees) * 100) : 0}%
                    </span>
                  </div>
                </div>
                <div className="metric-bar-track">
                  <div
                    className="metric-bar-fill"
                    style={{
                      width: `${totalEmployees > 0 ? (presentToday / totalEmployees) * 100 : 0}%`,
                      background: "var(--miracle-light-blue, #00AAE7)",
                    }}
                  ></div>
                </div>
              </div>

              {/* Currently Inside */}
              <div className="metric-bar-item">
                <div className="metric-bar-header">
                  <span className="metric-bar-label">
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--miracle-medium-blue, #2368A0)", display: "inline-block" }}></span>
                    Currently Inside Facility
                  </span>
                  <div className="metric-bar-counts">
                    <span className="metric-bar-num">{insideNow}</span>
                    <span className="metric-bar-pct">
                      {totalEmployees > 0 ? Math.round((insideNow / totalEmployees) * 100) : 0}%
                    </span>
                  </div>
                </div>
                <div className="metric-bar-track">
                  <div
                    className="metric-bar-fill"
                    style={{
                      width: `${totalEmployees > 0 ? (insideNow / totalEmployees) * 100 : 0}%`,
                      background: "var(--miracle-medium-blue, #2368A0)",
                    }}
                  ></div>
                </div>
              </div>

              {/* Late Today */}
              <div className="metric-bar-item">
                <div className="metric-bar-header">
                  <span className="metric-bar-label">
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--miracle-red, #EF4048)", display: "inline-block" }}></span>
                    Late Today
                  </span>
                  <div className="metric-bar-counts">
                    <span className="metric-bar-num">{lateToday}</span>
                    <span className="metric-bar-pct">
                      {totalEmployees > 0 ? Math.round((lateToday / totalEmployees) * 100) : 0}%
                    </span>
                  </div>
                </div>
                <div className="metric-bar-track">
                  <div
                    className="metric-bar-fill"
                    style={{
                      width: `${totalEmployees > 0 ? (lateToday / totalEmployees) * 100 : 0}%`,
                      background: "var(--miracle-red, #EF4048)",
                    }}
                  ></div>
                </div>
              </div>
            </div>

            {/* Department Breakdown Chips */}
            {deptStats.length > 0 && (
              <div className="dept-pills-row">
                {deptStats.map((ds) => (
                  <div key={ds.name} className="dept-pill" title={`${ds.present} of ${ds.total} present in ${ds.name}`}>
                    <span className="dept-pill-name">{ds.name}:</span>
                    <span className="dept-pill-count">{ds.present} / {ds.total}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DashboardCameraCard({ camera, onView }) {
  const [streamError, setStreamError] = useState(false);
  const streamIdRef = useRef(globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
  const isOnline = Boolean(camera.enabled);
  const streamUrl = isOnline
    ? `${API_URL}/cameras/${camera.id}/stream.mjpg?stream_id=${encodeURIComponent(streamIdRef.current)}`
    : "";

  useEffect(() => {
    if (!isOnline) return undefined;
    const streamId = streamIdRef.current;
    return () => {
      fetch(`${API_URL}/cameras/${camera.id}/stream/${encodeURIComponent(streamId)}/stop`, {
        method: "POST",
        keepalive: true,
      }).catch(() => {});
    };
  }, [camera.id, isOnline]);

  const tooltipText = [
    `Name: ${camera.name}`,
    `Type: ${camera.source_type === "webcam" ? "Local Webcam" : "IP / CC Camera"}`,
    `Source: ${camera.device || camera.source || "Default Device"}`,
    `Assigned: ${camera.roles?.length ? camera.roles.join(", ") : "Not assigned"}`,
    `Status: ${camera.enabled ? "Active & Streaming" : "Disabled"}`,
  ].join("\n");

  return (
    <div
      className={`dashboard-cam-card ${!isOnline ? "disabled" : ""}`}
      onClick={isOnline ? onView : undefined}
      title={tooltipText}
    >
      <div className="dashboard-cam-preview-box">
        {isOnline && !streamError ? (
          <img
            src={streamUrl}
            alt={`Live feed of ${camera.name}`}
            className="dashboard-cam-img"
            onError={() => setStreamError(true)}
          />
        ) : (
          <div className="dashboard-cam-placeholder">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
              <circle cx="12" cy="13" r="4"></circle>
            </svg>
            <span className="cam-placeholder-text">
              {!isOnline ? "Camera Disabled" : "Connecting Stream…"}
            </span>
          </div>
        )}

        <div className="dashboard-cam-overlay-top">
          <span className={`cam-status-pill ${isOnline ? "online" : "offline"}`}>
            <span className="cam-status-dot"></span>
            {isOnline ? "ONLINE" : "DISABLED"}
          </span>
          <span className="cam-type-pill">
            {camera.source_type === "webcam" ? "Webcam" : "IP Camera"}
          </span>
        </div>

        {isOnline && (
          <div className="dashboard-cam-click-hint">
            <span>Click for fullscreen</span>
          </div>
        )}

        {/* Clear hover tooltip with useful details */}
        <div className="dashboard-cam-tooltip">
          <div className="cam-tt-header">
            <strong>{camera.name}</strong>
            <span className={`cam-tt-status ${isOnline ? "active" : "inactive"}`}>
              {isOnline ? "Connected" : "Inactive"}
            </span>
          </div>
          <div className="cam-tt-row">
            <span className="cam-tt-label">Source:</span>
            <span className="cam-tt-val">{camera.device || camera.source || "Default"}</span>
          </div>
          <div className="cam-tt-row">
            <span className="cam-tt-label">Type:</span>
            <span className="cam-tt-val">{camera.source_type === "webcam" ? "Webcam" : "IP / CC Camera"}</span>
          </div>
          <div className="cam-tt-row">
            <span className="cam-tt-label">Purpose:</span>
            <span className="cam-tt-val">{camera.roles?.join(" · ") || "Not assigned"}</span>
          </div>
          <div className="cam-tt-row">
            <span className="cam-tt-label">Status:</span>
            <span className="cam-tt-val">{camera.enabled ? "Active Stream" : "Disabled"}</span>
          </div>
        </div>
      </div>

      <div className="dashboard-cam-info">
        <div className="dashboard-cam-meta">
          <div className="dashboard-cam-name" title={camera.name}>{camera.name}</div>
          <div className="dashboard-cam-roles">
            {camera.roles && camera.roles.length > 0 ? (
              camera.roles.map((role) => (
                <span key={role} className={`dashboard-cam-role-badge role-${role.toLowerCase()}`}>
                  {role === "ENTRY" ? "Entry" : role === "EXIT" ? "Exit" : role === "ENROLLMENT" ? "Enrollment" : role}
                </span>
              ))
            ) : (
              <span className="dashboard-cam-role-badge role-unassigned">General</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CameraCard({ camera, onView, onEdit, onDelete, onToggle, onTest }) {
  return (
    <article className={`camera-card ${camera.enabled ? "" : "camera-card-disabled"}`}>
      <div className="camera-header">
        <div>
          <div className="camera-name">{camera.name}</div>
          <div className="camera-responsibility">{camera.source_type === "webcam" ? "Webcam" : "IP / CC camera"}</div>
        </div>

        <div className={`connection-badge ${camera.enabled ? "configured" : "disconnected"}`}>
          <span>●</span>{camera.enabled ? "ENABLED" : "DISABLED"}
        </div>
      </div>

      <div className="camera-details">
        <div>
          <div className="detail-label">Source</div>
          <div className="detail-value">{camera.device || "--"}</div>
        </div>
        <div>
          <div className="detail-label">Assigned to</div>
          <div className="detail-value">{camera.roles?.length ? camera.roles.join(" · ") : "Not assigned"}</div>
        </div>
      </div>

      <div className="camera-card-actions">
        <button type="button" className="camera-action-button" onClick={onView} disabled={!camera.enabled}>View</button>
        <button type="button" className="camera-action-button" onClick={onTest} disabled={!camera.enabled}>Test</button>
        <button type="button" className="camera-action-button" onClick={onEdit}>Edit</button>
        <button type="button" className="camera-action-button" onClick={onToggle}>{camera.enabled ? "Disable" : "Enable"}</button>
        <button type="button" className="camera-action-button danger" onClick={onDelete}>Delete</button>
      </div>
    </article>
  );
}

function AttendanceTable({
  employees,
  getAttendance,
  getStatus,
  formatStatus,
  formatTime,
  formatWorkedTime,
  formatBreakTime,
  statusClass,
  search,
  setSearch,
  deptFilter,
  setDeptFilter,
  locationFilter,
  setLocationFilter,
  allDepartments = [],
  allLocations = [],
  isHr = false,
  hrDepartment = "",
  statusFilter,
  setStatusFilter,
  openEmployeeHistory,
  onViewDaily,
  loading,
  tableTitle = "Today's Attendance",
  tableCaption = "Event-based attendance and working-time summary",
}) {
  const filters = [
    ["ALL", "All"],
    ["PRESENT", "Present"],
    ["EARLY", "Early"],
    ["ON_TIME", "On Time"],
    ["LATE", "Late"],
    ["INSIDE", "Inside"],
    ["OUTSIDE", "Outside"],
  ];

  return (
    <section className="section">
      <div className="section-header">
        <div>
          <div className="section-title">{tableTitle}</div>
          <div className="section-caption">
            {tableCaption}
          </div>
        </div>
      </div>

      <div className="table-card">
        {/* Filter Toolbar: Department, Employee Search, Work Location & Status */}
        <div className="table-toolbar" style={{ flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
          <div className="search-box" style={{ minWidth: "220px", flex: "1 1 200px" }}>
            <span className="search-icon">⌕</span>

            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search employee name or ID..."
            />
          </div>

          {/* Department Filter (kept in toolbar as required) */}
          {isHr ? (
            <div className="card-tag-badge card-tag-dept" style={{ padding: "8px 12px", fontSize: "13px" }}>
              Dept: {hrDepartment}
            </div>
          ) : (
            <select
              className="filter-select-box"
              value={deptFilter}
              onChange={(e) => setDeptFilter && setDeptFilter(e.target.value)}
            >
              <option value="ALL">All Departments</option>
              {allDepartments.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
          )}

          {/* Work Location Filter (kept in toolbar as required) */}
          <select
            className="filter-select-box"
            value={locationFilter}
            onChange={(e) => setLocationFilter && setLocationFilter(e.target.value)}
          >
            <option value="ALL">All Locations</option>
            {allLocations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>

          {/* Reset Filters button */}
          {(search || (deptFilter && deptFilter !== "ALL") || (locationFilter && locationFilter !== "ALL") || statusFilter !== "ALL") && (
            <button
              type="button"
              className="clear-filters-btn"
              onClick={() => {
                setSearch("");
                if (setDeptFilter) setDeptFilter(isHr && hrDepartment ? hrDepartment : "ALL");
                if (setLocationFilter) setLocationFilter("ALL");
                setStatusFilter("ALL");
              }}
            >
              Reset
            </button>
          )}

          <div className="filter-group" style={{ marginLeft: "auto" }}>
            {filters.map(([value, label]) => (
              <button
                key={value}
                className={`filter-button ${
                  statusFilter === value || (value === "INSIDE" && statusFilter === "INSIDE_NOW") ? "active" : ""
                }`}
                onClick={() => setStatusFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>First In</th>
                <th>Last Out</th>
                <th>Arrival</th>
                <th>Worked</th>
                <th>Break</th>
                <th>Sessions</th>
                <th>State</th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="9">
                    <div className="empty-state">
                      Loading attendance...
                    </div>
                  </td>
                </tr>
              ) : employees.length === 0 ? (
                <tr>
                  <td colSpan="9">
                    <div className="empty-state">
                      <div className="empty-icon">◷</div>
                      No matching attendance records found.
                    </div>
                  </td>
                </tr>
              ) : (
                employees.map((employee) => {
                  const record = getAttendance(employee.employee_id);
                  const status = getStatus(record);

                  return (
                    <tr key={employee.employee_id}>
                      <td>
                        <div className="employee-cell">
                          <div className="avatar">
                            {String(employee.employee_name || "E")
                              .charAt(0)
                              .toUpperCase()}
                          </div>

                          <div>
                            <div className="employee-name">
                              {employee.employee_name}
                            </div>

                            <div className="employee-id">
                              ID: {employee.employee_id}
                            </div>
                          </div>
                        </div>
                      </td>

                      <td>{formatTime(record?.first_in)}</td>

                      <td>{formatTime(record?.last_out)}</td>

                      <td>
                        <span
                          className={`status-badge ${statusClass(status)}`}
                        >
                          {formatStatus(status)}
                        </span>
                      </td>

                      <td>
                        <strong>
                          {formatWorkedTime(record)}
                        </strong>
                      </td>

                      <td>
                        <span style={{ color: "#475467", fontSize: 13 }}>
                          {formatBreakTime ? formatBreakTime(record) : (record?.break_hours || "--")}
                        </span>
                      </td>

                      <td>
                        {record?.session_count ??
                          record?.sessions?.length ??
                          0}
                      </td>

                      <td>
                        <span
                          className={`status-badge ${statusClass(
                            String(
                              record?.current_state || "OUTSIDE"
                            ).toUpperCase()
                          )}`}
                        >
                          {String(
                            record?.current_state || "OUTSIDE"
                          ).toUpperCase()}
                        </span>
                      </td>

                      <td>
                        <button
                          type="button"
                          className="action-button"
                          onClick={() => {
                            if (onViewDaily) {
                              onViewDaily(employee, record);
                            } else {
                              openEmployeeHistory(employee);
                            }
                          }}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export default App;