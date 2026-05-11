import json
import os
import re
import sys

import pdfplumber


def normalize_cell(value):
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def first_non_empty(cells):
    for cell in cells:
        if cell:
            return cell
    return ""


def build_report_metadata(pdf, file_path):
    first_page_text = pdf.pages[0].extract_text() or ""
    lines = [line.strip() for line in first_page_text.splitlines() if line.strip()]

    report_title = "Store Close Report"
    if lines and lines[0].lower() == "store close":
        report_title = "Store Close Report"

    store_name = lines[1] if len(lines) > 1 else ""
    store_number_match = re.search(r"Store\s*#\s*([^\s]+)", first_page_text, re.IGNORECASE)
    period_match = re.search(r"PERIOD FROM:\s*(.+?)\s+TO:\s*(.+)", first_page_text, re.IGNORECASE)

    return {
        "sourceFile": file_path,
        "reportTitle": report_title,
        "reportType": "gilbarco_storeclose_pdf",
        "storeNumber": store_number_match.group(1).strip() if store_number_match else "",
        "periodLabel": "Store Close",
        "openPeriod": period_match.group(1).strip() if period_match else "",
        "closePeriod": period_match.group(2).strip() if period_match else "",
        "scopeLabel": store_name,
    }


def is_plu_data_row(cells):
    return parse_plu_row(cells) is not None


def is_department_data_row(cells):
    return parse_department_row(cells) is not None


def is_currency(value):
    return re.fullmatch(r"\$-?[\d,]+\.\d{2}", value or "") is not None


def is_percent(value):
    return re.fullmatch(r"-?[\d.]+%", value or "") is not None


def is_integer(value):
    return re.fullmatch(r"\d[\d,]*", value or "") is not None


def is_plu_number(value):
    return re.fullmatch(r"\d[\dA-Za-z]*", value or "") is not None


def clean_multiline(value):
    return normalize_cell(value).replace(" \n ", " ")


def parse_plu_row(cells):
    if len(cells) > 11 and is_plu_number(cells[1]) and is_integer(cells[7]) and is_currency(cells[8]) and is_currency(cells[9]) and is_percent(cells[10]) and is_percent(cells[11]):
        return {
            "PLU No.": cells[1],
            "Pkg. Qty": cells[2],
            "Description": clean_multiline(cells[4]),
            "Department": clean_multiline(cells[5]),
            "Count": cells[7],
            "Price": cells[8],
            "Sales": cells[9],
            "% of Dept": cells[10],
            "% of Total": cells[11],
        }

    if len(cells) > 9 and is_plu_number(cells[1]) and is_integer(cells[5]) and is_currency(cells[6]) and is_currency(cells[7]) and is_percent(cells[8]) and is_percent(cells[9]):
        return {
            "PLU No.": cells[1],
            "Pkg. Qty": cells[2],
            "Description": clean_multiline(cells[3]),
            "Department": clean_multiline(cells[4]),
            "Count": cells[5],
            "Price": cells[6],
            "Sales": cells[7],
            "% of Dept": cells[8],
            "% of Total": cells[9],
        }

    if len(cells) > 21 and is_plu_number(cells[1]) and is_integer(cells[10]) and is_currency(cells[13]) and is_currency(cells[16]) and is_percent(cells[18]) and is_percent(cells[21]):
        return {
            "PLU No.": cells[1],
            "Pkg. Qty": cells[2],
            "Description": clean_multiline(cells[3]),
            "Department": clean_multiline(cells[6]),
            "Count": cells[10],
            "Price": cells[13],
            "Sales": cells[16],
            "% of Dept": cells[18],
            "% of Total": cells[21],
        }

    return None


def parse_department_row(cells):
    if len(cells) > 21 and cells[1] and is_currency(cells[3]) and is_integer(cells[5]) and is_integer(cells[8]) and is_integer(cells[9]) and is_currency(cells[12]) and is_currency(cells[15]) and is_currency(cells[18]) and is_percent(cells[21]):
        return {
            "Department": clean_multiline(cells[1]),
            "Gross Sales": cells[3],
            "Item Count": cells[5],
            "Refund Count": cells[8],
            "Net Count": cells[9],
            "Refund $": cells[12],
            "Discount $": cells[15],
            "Net Sales": cells[18],
            "% of Sales": cells[21],
        }

    if len(cells) > 11 and cells[1] and is_currency(cells[3]) and is_integer(cells[5]) and is_integer(cells[6]) and is_integer(cells[7]) and is_currency(cells[8]) and is_currency(cells[9]) and is_currency(cells[10]) and is_percent(cells[11]):
        return {
            "Department": clean_multiline(cells[1]),
            "Gross Sales": cells[3],
            "Item Count": cells[5],
            "Refund Count": cells[6],
            "Net Count": cells[7],
            "Refund $": cells[8],
            "Discount $": cells[9],
            "Net Sales": cells[10],
            "% of Sales": cells[11],
        }

    return None


def parse_fuel_row(cells):
    if len(cells) > 6 and cells[1].startswith("Grade ") and cells[2] and cells[3] and is_currency(cells[4]) and is_percent(cells[6]):
        return {
            "Grade": clean_multiline(cells[1]),
            "Grade Name": clean_multiline(cells[2]),
            "Volume": cells[3],
            "Sales": cells[4],
            "% of Total Fuel Sales": cells[6],
        }

    if len(cells) > 4 and cells[0].startswith("Grade ") and cells[1] and cells[2] and is_currency(cells[3]) and is_percent(cells[4]):
        return {
            "Grade": clean_multiline(cells[0]),
            "Grade Name": clean_multiline(cells[1]),
            "Volume": cells[2],
            "Sales": cells[3],
            "% of Total Fuel Sales": cells[4],
        }

    return None


def parse_pdf_report(file_path):
    with pdfplumber.open(file_path) as pdf:
        metadata = build_report_metadata(pdf, file_path)
        fuel_rows = []
        plu_rows = []
        department_rows = []
        in_fuel = False
        in_plu = False
        in_department = False

        for page in pdf.pages:
            for table in page.extract_tables() or []:
                for raw_row in table:
                    cells = [normalize_cell(cell) for cell in (raw_row or [])]
                    if not any(cells):
                        continue

                    marker = first_non_empty(cells)

                    if marker == "Fuel Sales":
                        in_fuel = True
                        continue

                    if marker == "PLU Sales Report":
                        in_plu = True
                        in_fuel = False
                        in_department = False
                        continue

                    if marker == "Department Sales Report":
                        in_department = True
                        in_fuel = False
                        in_plu = False
                        continue

                    if marker == "Store Till Summary Report":
                        in_department = False
                        continue

                    if in_fuel and (marker.startswith("Total Fuel Sales") or marker == "Fuel Discounts"):
                        in_fuel = False
                        continue

                    if in_plu and marker.startswith("Total PLU"):
                        in_plu = False
                        continue

                    if in_fuel:
                        if cells[1] == "Grade" or marker == "Grade":
                            continue
                        fuel_row = parse_fuel_row(cells)
                        if fuel_row:
                            fuel_rows.append(fuel_row)
                        continue

                    if in_plu:
                        if cells[1] == "PLU No.":
                            continue
                        plu_row = parse_plu_row(cells)
                        if plu_row:
                            plu_rows.append(plu_row)
                        continue

                    if in_department:
                        if cells[1] == "Dept. Name" or cells[1] == "Gross Refund":
                            continue
                        if cells[1] == "":
                            continue
                        department_row = parse_department_row(cells)
                        if department_row:
                            department_rows.append(department_row)

        return {
            **metadata,
            "sections": [
                {
                    "title": "Gasoline Grade",
                    "headers": [
                        "Grade",
                        "Grade Name",
                        "Volume",
                        "Sales",
                        "% of Total Fuel Sales",
                    ],
                    "rows": fuel_rows,
                    "totalRows": len(fuel_rows),
                    "truncated": False,
                },
                {
                    "title": "Category",
                    "headers": [
                        "Department",
                        "Gross Sales",
                        "Item Count",
                        "Refund Count",
                        "Net Count",
                        "Refund $",
                        "Discount $",
                        "Net Sales",
                        "% of Sales",
                    ],
                    "rows": department_rows,
                    "totalRows": len(department_rows),
                    "truncated": False,
                },
                {
                    "title": "PLU",
                    "headers": [
                        "PLU No.",
                        "Pkg. Qty",
                        "Description",
                        "Department",
                        "Count",
                        "Price",
                        "Sales",
                        "% of Dept",
                        "% of Total",
                    ],
                    "rows": plu_rows,
                    "totalRows": len(plu_rows),
                    "truncated": False,
                },
            ],
        }


def main():
    if len(sys.argv) < 2:
      raise SystemExit("Usage: python src/pdf_report_parser.py <pdf-path>")

    file_path = os.path.abspath(sys.argv[1])
    report = parse_pdf_report(file_path)
    sys.stdout.write(json.dumps(report))


if __name__ == "__main__":
    main()
