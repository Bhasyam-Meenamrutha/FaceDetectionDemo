"""Generate attendance XLSX reports using the exact Sample.xlsx column labels."""

import calendar
import re
from datetime import date, datetime, timedelta
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from attendance import get_connection, get_employee, get_employee_attendance_history

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Exact labels and order from Sample.xlsx. Do not rename these fields.
FIXED_COLUMNS = [
    "#", "Code", "Emp-ID", "Last Name", "First Name", "Dept", "Practice",
    "Reporting Person", "Manager", "Work Location", "Working From", "HR Contact",
]
SUMMARY_COLUMNS = [
    "P", "Half Day", "Actual Working Days", "Half Day", "Tot. Leaves",
    "Holidays", "Week ends", "No of Days in a Month",
]
SAMPLE_SHEET_NAME = "FINAL Attendance Sep2026"


def _parse_report_date(value):
    if not value:
        return date.today()
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return datetime.strptime(str(value).strip(), "%Y-%m-%d").date()
    except (TypeError, ValueError) as error:
        raise ValueError("date must use YYYY-MM-DD format") from error


def _period_dates(period, selected_date=None, start_date=None, end_date=None):
    norm_period = str(period or "month").strip().lower()
    if norm_period in ("day", "daily"):
        target = _parse_report_date(selected_date or start_date)
        return target, target
    if norm_period in ("week", "weekly"):
        selected = _parse_report_date(selected_date or start_date)
        start = selected - timedelta(days=selected.weekday())
        return start, start + timedelta(days=6)
    if norm_period in ("month", "monthly"):
        selected = _parse_report_date(selected_date or start_date)
        start = selected.replace(day=1)
        end = selected.replace(day=calendar.monthrange(selected.year, selected.month)[1])
        return start, end
    if norm_period in ("custom", "custom_range", "range"):
        if not start_date or not end_date:
            raise ValueError("Both start_date and end_date are required for a custom date range.")
        start, end = _parse_report_date(start_date), _parse_report_date(end_date)
        if start > end:
            raise ValueError("Start date must be before or equal to end date.")
        return start, end
    raise ValueError("period must be 'day', 'week', 'month', or 'custom'")


def _history_for_range(employee_id, start_date, end_date):
    rows = {}
    cursor = start_date.replace(day=1)
    while cursor <= end_date:
        history = get_employee_attendance_history(employee_id, cursor.year, cursor.month)
        if history is None:
            raise LookupError(f"Employee '{employee_id}' not found")
        rows.update({item["date"]: item for item in history.get("attendance", [])})
        if cursor.month == 12:
            cursor = cursor.replace(year=cursor.year + 1, month=1)
        else:
            cursor = cursor.replace(month=cursor.month + 1)
    return [
        rows.get((start_date + timedelta(days=offset)).isoformat())
        for offset in range((end_date - start_date).days + 1)
    ]


def _employee_rows(department=None):
    connection = get_connection()
    try:
        query = """SELECT employee_id, employee_name, shift_start, shift_end,
                          email, login_id, department, designation, team_name,
                          reports_to, reports_to_mail_id, hr_contact, hr_email,
                          work_location, is_flexible_shift
                   FROM employees WHERE 1=1"""
        params = []
        if department and str(department).upper() != "ALL":
            query += " AND LOWER(department) = LOWER(?)"
            params.append(str(department).strip())
        query += " ORDER BY employee_name COLLATE NOCASE"
        return [dict(row) for row in connection.execute(query, tuple(params)).fetchall()]
    finally:
        connection.close()


def _safe_filename(value):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value)).strip("_.") or "attendance"


def _split_name(name):
    parts = str(name or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[-1], " ".join(parts[:-1])


def _day_code(day):
    if not day:
        return "A"
    status = str(day.get("status") or "").strip().upper()
    if status == "FULL_DAY":
        return "P"
    if status == "HALF_DAY":
        return "Half Day"
    if status == "LEAVE":
        return day.get("leave_type") or "L"
    if status == "WEEKEND":
        return "W"
    if status == "HOLIDAY":
        return "H"
    if status == "ABSENT":
        return "A"
    return "P" if int(day.get("worked_minutes") or 0) > 0 else "A"


def _style_cell(cell, *, fill=None, font=None, horizontal="center"):
    cell.alignment = Alignment(horizontal=horizontal, vertical="center", wrap_text=True)
    if fill:
        cell.fill = fill
    if font:
        cell.font = font


def _add_attendance_rows(workbook, employees, start_date, end_date):
    # The sample layout is a monthly attendance matrix. If a weekly/custom
    # range is selected, the same layout is retained and the selected month
    # determines the day columns; days outside the requested range are blank.
    report_month = start_date.replace(day=1)
    last_day = calendar.monthrange(report_month.year, report_month.month)[1]
    sheet = workbook.active
    sheet.title = SAMPLE_SHEET_NAME

    dark_fill = PatternFill("solid", fgColor="1F4E78")
    light_fill = PatternFill("solid", fgColor="D9EAF7")
    white_bold = Font(bold=True, color="FFFFFF")
    bold = Font(bold=True)
    thin_gray = Side(style="thin", color="B7C9D6")
    border = Border(left=thin_gray, right=thin_gray, top=thin_gray, bottom=thin_gray)

    # Row 1 contains the report title, selected month, weekday names and summary title.
    sheet.cell(1, 1, f"Offshore Attendance | {report_month.strftime('%b%Y')}")
    sheet.cell(1, 12, datetime(report_month.year, report_month.month, 1))
    sheet.cell(1, 12).number_format = "mmm-yy"
    sheet.cell(1, 44, "Attendance - Summary")
    for col in range(1, 52):
        cell = sheet.cell(1, col)
        _style_cell(cell, fill=dark_fill, font=white_bold)
        cell.border = border
    sheet.cell(1, 1).alignment = Alignment(horizontal="left", vertical="center")

    # Row 2 uses the sample's exact static labels; day columns are dates.
    for col, label in enumerate(FIXED_COLUMNS, start=1):
        sheet.cell(2, col, label)
    for day_num in range(1, 32):
        col = 12 + day_num
        if day_num <= last_day:
            day_date = date(report_month.year, report_month.month, day_num)
            sheet.cell(2, col, day_date)
            sheet.cell(2, col).number_format = "d"
            sheet.cell(1, col, day_date.strftime("%a"))
        else:
            sheet.cell(2, col, None)
            sheet.cell(1, col, None)
    for col, label in enumerate(SUMMARY_COLUMNS, start=44):
        sheet.cell(2, col, label)
    for cell in sheet[2]:
        _style_cell(cell, fill=light_fill, font=bold)
        cell.border = border
    sheet.row_dimensions[1].height = 24
    sheet.row_dimensions[2].height = 34

    for index, employee in enumerate(employees, start=1):
        row_num = index + 2
        last_name, first_name = _split_name(employee.get("employee_name"))
        employee_id = employee.get("employee_id") or ""
        login_id = employee.get("login_id") or ""
        department = employee.get("department") or ""
        practice = employee.get("team_name") or employee.get("designation") or ""
        reporting_person = employee.get("reports_to") or ""
        manager = employee.get("reports_to_mail_id") or ""
        work_location = employee.get("work_location") or ""
        # No "Working From" field exists in the current employee schema.
        working_from = ""
        hr_contact = employee.get("hr_contact") or employee.get("hr_email") or ""

        fixed_values = [
            index, login_id, employee_id, last_name, first_name, department,
            practice, reporting_person, manager, work_location, working_from, hr_contact,
        ]
        for col, value in enumerate(fixed_values, start=1):
            sheet.cell(row_num, col, value)

        days = _history_for_range(employee_id, report_month, date(report_month.year, report_month.month, last_day))
        present_count = half_day_count = leave_count = holiday_count = weekend_count = 0
        actual_working_days = 0
        for day_num in range(1, 32):
            col = 12 + day_num
            if day_num > last_day:
                sheet.cell(row_num, col, None)
                continue
            current_date = date(report_month.year, report_month.month, day_num)
            day = days[day_num - 1]
            if not (start_date <= current_date <= end_date):
                code = ""
            else:
                code = _day_code(day)
            sheet.cell(row_num, col, code)
            if start_date <= current_date <= end_date:
                status = str((day or {}).get("status") or "").upper()
                if current_date.weekday() >= 5 or status == "WEEKEND":
                    weekend_count += 1
                elif status == "HOLIDAY" or code == "H":
                    holiday_count += 1
                else:
                    actual_working_days += 1
                if code == "P":
                    present_count += 1
                elif code == "Half Day":
                    half_day_count += 1
                elif status == "LEAVE":
                    leave_count += 1

        summary_values = [
            present_count, half_day_count, actual_working_days, half_day_count,
            leave_count, holiday_count, weekend_count, (end_date - start_date).days + 1,
        ]
        for col, value in enumerate(summary_values, start=44):
            sheet.cell(row_num, col, value)

        for cell in sheet[row_num]:
            cell.border = border
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        for col in (4, 5, 6, 7, 8, 9, 10, 12):
            sheet.cell(row_num, col).alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)

    widths = {
        1: 5, 2: 12, 3: 14, 4: 16, 5: 18, 6: 20, 7: 20, 8: 22, 9: 22,
        10: 22, 11: 16, 12: 20,
    }
    for col in range(13, 44):
        widths[col] = 5
    for col in range(44, 52):
        widths[col] = [8, 12, 18, 10, 12, 12, 12, 20][col - 44]
    for col, width in widths.items():
        sheet.column_dimensions[get_column_letter(col)].width = width
    sheet.freeze_panes = "M3"
    sheet.auto_filter.ref = f"A2:AY{max(2, len(employees) + 2)}"
    sheet.sheet_view.showGridLines = False
    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.orientation = "landscape"
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    sheet.print_title_rows = "1:2"


def _create_report(employees, period, selected_date, report_name, start_date=None, end_date=None):
    start_date_obj, end_date_obj = _period_dates(period, selected_date, start_date, end_date)
    workbook = Workbook()
    _add_attendance_rows(workbook, employees, start_date_obj, end_date_obj)
    output = BytesIO()
    workbook.save(output)
    filename = (
        f"{_safe_filename(report_name)}_{period}_attendance_"
        f"{start_date_obj:%Y%m%d}_to_{end_date_obj:%Y%m%d}.xlsx"
    )
    return output.getvalue(), filename


def create_employee_report(employee_id, period="month", selected_date=None, start_date=None, end_date=None, date=None):
    employee = get_employee(employee_id)
    if employee is None:
        raise LookupError(f"Employee '{employee_id}' not found")
    target_date = selected_date or date
    return _create_report([dict(employee)], period, target_date, employee_id, start_date, end_date)


def create_all_employees_report(period="month", selected_date=None, start_date=None, end_date=None, department=None, date=None):
    target_date = selected_date or date
    return _create_report(
        _employee_rows(department=department), period, target_date, "all_employees", start_date, end_date
    )
