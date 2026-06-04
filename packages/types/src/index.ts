// Shared Types zwischen API und Web

export type Role = "ADMIN" | "MANAGER" | "EMPLOYEE";
export type FederalState =
  | "NIEDERSACHSEN"
  | "BAYERN"
  | "BERLIN"
  | "BRANDENBURG"
  | "BREMEN"
  | "HAMBURG"
  | "HESSEN"
  | "MECKLENBURG_VORPOMMERN"
  | "NORDRHEIN_WESTFALEN"
  | "RHEINLAND_PFALZ"
  | "SAARLAND"
  | "SACHSEN"
  | "SACHSEN_ANHALT"
  | "SCHLESWIG_HOLSTEIN"
  | "THUERINGEN"
  | "BADEN_WUERTTEMBERG";

export type TimeEntrySource = "NFC" | "MOBILE" | "MANUAL" | "CORRECTION";
export type LeaveRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
export type AbsenceType = "SICK" | "SICK_CHILD" | "SPECIAL_LEAVE" | "UNPAID_LEAVE" | "OTHER";
export type OvertimePlanStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";

export interface Employee {
  id: string;
  tenantId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  hireDate: string;
  exitDate?: string;
  nfcCardId?: string;
}

export interface TimeEntry {
  id: string;
  employeeId: string;
  date: string;
  startTime: string;
  endTime?: string;
  breakMinutes: number;
  source: TimeEntrySource;
  note?: string;
  isLocked: boolean;
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  days: number;
  halfDay: boolean;
  status: LeaveRequestStatus;
  note?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
}

export interface OvertimeAccount {
  id: string;
  employeeId: string;
  balanceHours: number;
  status: "NORMAL" | "ELEVATED" | "CRITICAL";
  threshold: number;
}

export interface ApiError {
  error: string;
  statusCode: number;
}
