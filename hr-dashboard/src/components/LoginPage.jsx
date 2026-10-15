import React, { useState } from "react";
import loginBg from "../assets/login-bg.jpg";
import miracleLogo from "../assets/miracle-logo.svg";

export default function LoginPage({ onLogin, apiBaseUrl = "http://127.0.0.1:8000" }) {
  // Credentials State (Username & Password only - role resolved purely by backend)
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // Status & Validation State
  const [isValidating, setIsValidating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  // Modal State
  const [showForgotModal, setShowForgotModal] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setErrorMessage("");
    setSuccessMessage("");

    const trimmedUser = username.trim();
    if (!trimmedUser) {
      setErrorMessage("Please enter your username.");
      return;
    }
    if (!password) {
      setErrorMessage("Please enter your password.");
      return;
    }

    setIsValidating(true);
    try {
      const res = await fetch(`${apiBaseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: trimmedUser,
          password: password,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || "Invalid credentials. Please verify your username and password.");
      }

      const authResult = await res.json();
      setSuccessMessage("Authentication verified. Redirecting to authorized portal...");
      setTimeout(() => {
        onLogin(authResult);
      }, 250);
    } catch (err) {
      setErrorMessage(err.message || "Login failed. Please check credentials.");
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <div className="miracle-login-root">
      <style>{`
        :root {
          /* Official Miracle Corporate Standard Colors */
          --miracle-light-blue: #00AAE7;
          --miracle-medium-blue: #2368A0;
          --miracle-dark-blue: #0D416B;
          --miracle-red: #EF4048;
          --miracle-black: #232527;
          --miracle-white: #FFFFFF;
          --miracle-dark-grey: #8C8C8C;
          --miracle-light-grey: #B7B2B3;
        }

        .miracle-login-root {
          min-height: 100vh;
          width: 100vw;
          margin: 0;
          padding: 0;
          display: flex;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          background: #ffffff;
          overflow-x: hidden;
          box-sizing: border-box;
          color: var(--miracle-black, #232527);
        }

        /* Split-screen Left Pane (Hero + Overlay) */
        .miracle-hero-pane {
          flex: 1.35;
          min-height: 100vh;
          position: relative;
          background-image: url('${loginBg}');
          background-size: cover;
          background-position: center 35%;
          background-repeat: no-repeat;
          display: flex;
          flex-direction: column;
          justify-content: flex-end;
          padding: 56px 64px;
          box-sizing: border-box;
        }

        .miracle-hero-overlay {
          position: absolute;
          inset: 0;
          background: linear-gradient(135deg, rgba(13, 65, 107, 0.92) 0%, rgba(35, 104, 160, 0.88) 100%);
          z-index: 1;
        }

        .miracle-hero-content {
          position: relative;
          z-index: 2;
          max-width: 680px;
        }

        .miracle-hero-title {
          color: #ffffff;
          font-size: 32px;
          font-weight: 400;
          line-height: 1.32;
          margin: 0 0 16px 0;
          letter-spacing: -0.015em;
          text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .miracle-hero-copyright {
          color: rgba(255, 255, 255, 0.72);
          font-size: 13.5px;
          margin: 0;
          letter-spacing: 0.01em;
        }

        /* Split-screen Right Pane (Login Form) */
        .miracle-form-pane {
          flex: 0.95;
          min-height: 100vh;
          background: #ffffff;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          padding: 40px 48px;
          box-sizing: border-box;
        }

        .miracle-form-box {
          width: 100%;
          max-width: 360px;
        }

        /* Brand Header */
        .miracle-brand-lockup {
          margin-bottom: 34px;
        }

        .miracle-logo-row {
          display: flex;
          align-items: baseline;
          gap: 1px;
          user-select: none;
        }

        .miracle-brand-m {
          font-size: 38px;
          font-weight: 800;
          color: #232527;
          letter-spacing: 1px;
          line-height: 1;
        }

        .miracle-brand-i {
          font-size: 38px;
          font-weight: 800;
          color: #232527;
          position: relative;
          display: inline-block;
          line-height: 1;
        }

        .miracle-brand-i-dot {
          position: absolute;
          top: -2px;
          left: 50%;
          transform: translateX(-50%);
          width: 6px;
          height: 6px;
          background: #00a8cc;
          border-radius: 50%;
        }

        .miracle-brand-rest {
          font-size: 38px;
          font-weight: 800;
          color: #232527;
          letter-spacing: 1px;
          line-height: 1;
        }

        .miracle-brand-sub {
          font-size: 12px;
          font-weight: 800;
          color: #00a8cc;
          letter-spacing: 2px;
          margin-top: 3px;
          text-transform: uppercase;
        }

        .miracle-platform-tag {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-top: 8px;
          font-size: 11px;
          font-weight: 600;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }

        .miracle-platform-tag .tag-badge {
          background: #e0f2fe;
          color: #0284c7;
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 10px;
          font-weight: 700;
        }

        /* Form Fields */
        .miracle-field-group {
          margin-bottom: 16px;
        }

        .miracle-input-card {
          border: 1px solid #dbe2ea;
          border-radius: 4px;
          background: #ffffff;
          padding: 8px 14px 9px 14px;
          transition: border-color 0.15s, box-shadow 0.15s;
          display: flex;
          flex-direction: column;
        }

        .miracle-input-card:focus-within {
          border-color: var(--miracle-light-blue, #00AAE7);
          box-shadow: 0 0 0 1px var(--miracle-light-blue, #00AAE7);
        }

        .miracle-field-label {
          font-size: 11px;
          font-weight: 600;
          color: #94a3b8;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 2px;
          display: block;
        }

        .miracle-input-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
        }

        .miracle-input-control {
          width: 100%;
          border: none;
          outline: none;
          background: transparent;
          font-size: 14.5px;
          color: #1e293b;
          padding: 0;
          margin: 0;
          font-family: inherit;
        }

        .miracle-input-control::placeholder {
          color: #94a3b8;
          font-weight: 400;
        }

        .miracle-eye-btn {
          background: none;
          border: none;
          padding: 4px;
          margin-left: 8px;
          color: #94a3b8;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          transition: color 0.15s;
        }

        .miracle-eye-btn:hover {
          color: #475569;
        }

        /* Forgot Password */
        .miracle-forgot-link {
          display: inline-block;
          font-size: 13px;
          font-weight: 500;
          color: var(--miracle-light-blue, #00AAE7);
          background: none;
          border: none;
          padding: 0;
          cursor: pointer;
          margin-top: 4px;
          margin-bottom: 18px;
          text-decoration: none;
          transition: color 0.15s, text-decoration 0.15s;
        }

        .miracle-forgot-link:hover {
          color: var(--miracle-medium-blue, #2368A0);
          text-decoration: underline;
        }

        /* Sign in Button */
        .miracle-btn-signin {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          background: var(--miracle-light-blue, #00AAE7);
          color: #ffffff;
          border: none;
          border-radius: 4px;
          padding: 9px 22px;
          font-size: 13.5px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.15s, transform 0.1s;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
        }

        .miracle-btn-signin:hover:not(:disabled) {
          background: var(--miracle-medium-blue, #2368A0);
        }

        .miracle-btn-signin:active:not(:disabled) {
          transform: translateY(1px);
        }

        .miracle-btn-signin:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }

        /* Alerts */
        .miracle-alert {
          border-radius: 4px;
          padding: 10px 14px;
          font-size: 12.5px;
          font-weight: 500;
          margin-bottom: 18px;
          display: flex;
          align-items: flex-start;
          gap: 9px;
          line-height: 1.4;
        }

        .miracle-alert-error {
          background: #fef2f2;
          border: 1px solid #fecaca;
          color: #b91c1c;
        }

        .miracle-alert-success {
          background: #ecfdf5;
          border: 1px solid #a7f3d0;
          color: #047857;
        }

        /* Modal Styles */
        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.6);
          backdrop-filter: blur(3px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 20px;
        }

        .modal-card {
          background: #ffffff;
          border-radius: 8px;
          width: 100%;
          max-width: 460px;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 10px 10px -5px rgba(0, 0, 0, 0.1);
          overflow: hidden;
          border: 1px solid #e2e8f0;
          animation: modalAppear 0.2s ease-out;
        }

        @keyframes modalAppear {
          from { opacity: 0; transform: scale(0.96); }
          to { opacity: 1; transform: scale(1); }
        }

        .modal-header {
          padding: 18px 22px;
          border-bottom: 1px solid #f1f5f9;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .modal-header h3 {
          margin: 0;
          font-size: 16px;
          font-weight: 700;
          color: #1e293b;
        }

        .modal-close-btn {
          background: none;
          border: none;
          font-size: 20px;
          color: #94a3b8;
          cursor: pointer;
          padding: 2px 6px;
          border-radius: 4px;
        }

        .modal-close-btn:hover {
          color: #1e293b;
          background: #f1f5f9;
        }

        .modal-body {
          padding: 22px;
          font-size: 13.5px;
          color: #475569;
          line-height: 1.6;
        }

        .modal-footer {
          padding: 14px 22px;
          background: #f8fafc;
          border-top: 1px solid #f1f5f9;
          display: flex;
          justify-content: flex-end;
        }

        .modal-btn-primary {
          background: var(--miracle-light-blue, #00AAE7);
          color: #ffffff;
          border: none;
          border-radius: 4px;
          padding: 8px 18px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }

        .modal-btn-primary:hover {
          background: var(--miracle-medium-blue, #2368A0);
        }

        /* Responsive Layout */
        @media (max-width: 880px) {
          .miracle-login-root {
            flex-direction: column;
          }

          .miracle-hero-pane {
            flex: none;
            min-height: 220px;
            padding: 32px 24px;
          }

          .miracle-hero-title {
            font-size: 22px;
          }

          .miracle-form-pane {
            flex: 1;
            min-height: auto;
            padding: 36px 24px;
          }
        }
      `}</style>

      {/* Left side: Enterprise hero with dark overlay and description */}
      <div className="miracle-hero-pane">
        <div className="miracle-hero-overlay" />
        <div className="miracle-hero-content">
          <h1 className="miracle-hero-title">
            FaceAttend - Miracle's Portal for<br />
            Enterprise Workforce Management
          </h1>
          <p className="miracle-hero-copyright">
            © 2026 Miracle Software Systems, Inc.
          </p>
        </div>
      </div>

      {/* Right side: White login panel */}
      <div className="miracle-form-pane">
        <div className="miracle-form-box">
          {/* Miracle & FaceAttend Branding */}
          <div className="miracle-brand-lockup">
            <img
              src={miracleLogo}
              alt="Miracle Software Systems"
              style={{ height: "38px", width: "auto", display: "block" }}
            />
            <div className="miracle-platform-tag">
              <span>FaceAttend</span>
              <span className="tag-badge">Biometric Platform</span>
            </div>
          </div>

          {errorMessage && (
            <div className="miracle-alert miracle-alert-error" role="alert">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: "1px" }}>
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && (
            <div className="miracle-alert miracle-alert-success" role="status">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: "1px" }}>
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span>{successMessage}</span>
            </div>
          )}

          <form onSubmit={handleLogin} noValidate>
            {/* Username Input Card */}
            <div className="miracle-field-group">
              <div className="miracle-input-card">
                <label className="miracle-field-label" htmlFor="miracle-username">
                  USERNAME
                </label>
                <div className="miracle-input-row">
                  <input
                    id="miracle-username"
                    className="miracle-input-control"
                    type="text"
                    placeholder="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    disabled={isValidating}
                    autoComplete="username"
                    autoFocus
                  />
                </div>
              </div>
            </div>

            {/* Password Input Card with Show/Hide toggle */}
            <div className="miracle-field-group">
              <div className="miracle-input-card">
                <label className="miracle-field-label" htmlFor="miracle-password">
                  PASSWORD
                </label>
                <div className="miracle-input-row">
                  <input
                    id="miracle-password"
                    className="miracle-input-control"
                    type={showPassword ? "text" : "password"}
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isValidating}
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="miracle-eye-btn"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? (
                      /* Eye icon (shown) */
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    ) : (
                      /* Eye-off icon (hidden with slash) */
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Forgot Password Link */}
            <div>
              <button
                type="button"
                className="miracle-forgot-link"
                onClick={() => setShowForgotModal(true)}
              >
                Forgot Password ?
              </button>
            </div>

            {/* Sign in Button */}
            <div>
              <button
                type="submit"
                className="miracle-btn-signin"
                disabled={isValidating}
                id="sign-in-btn"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>{isValidating ? "Signing in..." : "Sign in"}</span>
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Forgot Password Modal */}
      {showForgotModal && (
        <div className="modal-overlay" onClick={() => setShowForgotModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>FaceAttend Account Recovery</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowForgotModal(false)}
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <p style={{ marginTop: 0 }}>
                For enterprise security, password resets must be verified through authorized administrative channels:
              </p>
              <ul style={{ paddingLeft: "20px", margin: "12px 0" }}>
                <li><strong>HR Managers:</strong> Please contact your System Administrator to reset your department credentials.</li>
                <li><strong>Administrators:</strong> Contact your Executive Superior for credential provisioning.</li>
                <li><strong>Employees:</strong> Please notify your assigned Department HR contact.</li>
              </ul>
              <p style={{ marginBottom: 0, fontSize: "12.5px", color: "#64748b" }}>
                Technical assistance is available at <strong>support@miraclesoft.com</strong> or via the Miracle IT Helpdesk.
              </p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="modal-btn-primary"
                onClick={() => setShowForgotModal(false)}
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
