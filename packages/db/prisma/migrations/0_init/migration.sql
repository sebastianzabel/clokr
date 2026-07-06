-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SaldoPeriodType" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "FederalState" AS ENUM ('NIEDERSACHSEN', 'BAYERN', 'BERLIN', 'BRANDENBURG', 'BREMEN', 'HAMBURG', 'HESSEN', 'MECKLENBURG_VORPOMMERN', 'NORDRHEIN_WESTFALEN', 'RHEINLAND_PFALZ', 'SAARLAND', 'SACHSEN', 'SACHSEN_ANHALT', 'SCHLESWIG_HOLSTEIN', 'THUERINGEN', 'BADEN_WUERTTEMBERG');

-- CreateEnum
CREATE TYPE "TimeEntryType" AS ENUM ('WORK', 'OVERTIME', 'PUBLIC_HOLIDAY');

-- CreateEnum
CREATE TYPE "TimeEntrySource" AS ENUM ('NFC', 'MOBILE', 'MANUAL', 'CORRECTION', 'WIFI');

-- CreateEnum
CREATE TYPE "OvertimeTransactionType" AS ENUM ('ACCRUAL', 'REDUCTION', 'PAYOUT', 'CORRECTION');

-- CreateEnum
CREATE TYPE "OvertimePlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'CANCELLATION_REQUESTED');

-- CreateEnum
CREATE TYPE "AbsenceType" AS ENUM ('SICK', 'SICK_CHILD', 'SPECIAL_LEAVE', 'UNPAID_LEAVE', 'MATERNITY', 'PARENTAL', 'OTHER', 'VOCATIONAL_SCHOOL');

-- CreateEnum
CREATE TYPE "AbsenceSource" AS ENUM ('PATTERN', 'MANUAL');

-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('FIXED_SCHEDULE', 'FLEXTIME', 'MONTHLY_HOURS', 'SHIFT_BASED');

-- CreateEnum
CREATE TYPE "EmployeeClassification" AS ENUM ('VOLLZEIT', 'TEILZEIT', 'MINIJOB', 'AZUBI', 'AUSHILFE', 'WERKSTUDENT', 'PRAKTIKANT');

-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'PREFERRED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "federalState" "FederalState" NOT NULL DEFAULT 'NIEDERSACHSEN',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "defaultWeeklyHours" DECIMAL(5,2) NOT NULL DEFAULT 40,
    "defaultMondayHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "defaultTuesdayHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "defaultWednesdayHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "defaultThursdayHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "defaultFridayHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "defaultSaturdayHours" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "defaultSundayHours" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "overtimeThreshold" DECIMAL(5,2) NOT NULL DEFAULT 60,
    "allowOvertimePayout" BOOLEAN NOT NULL DEFAULT false,
    "defaultVacationDays" DECIMAL(5,2) NOT NULL DEFAULT 30,
    "carryOverDeadlineDay" INTEGER NOT NULL DEFAULT 31,
    "carryOverDeadlineMonth" INTEGER NOT NULL DEFAULT 3,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpUser" TEXT,
    "smtpPassword" TEXT,
    "smtpFromEmail" TEXT,
    "smtpFromName" TEXT,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT false,
    "twoFaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "passwordMinLength" INTEGER NOT NULL DEFAULT 12,
    "passwordRequireUpper" BOOLEAN NOT NULL DEFAULT true,
    "passwordRequireLower" BOOLEAN NOT NULL DEFAULT true,
    "passwordRequireDigit" BOOLEAN NOT NULL DEFAULT true,
    "passwordRequireSpecial" BOOLEAN NOT NULL DEFAULT true,
    "sessionTimeoutMinutes" INTEGER NOT NULL DEFAULT 60,
    "refreshTokenDays" INTEGER NOT NULL DEFAULT 7,
    "rememberMeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "rememberMeDays" INTEGER NOT NULL DEFAULT 30,
    "maxSessionsPerUser" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin',
    "phorestBusinessId" TEXT,
    "phorestBranchId" TEXT,
    "phorestUsername" TEXT,
    "phorestPassword" TEXT,
    "phorestBaseUrl" TEXT DEFAULT 'https://api.phorest.com/third-party-api-server',
    "phorestAutoSync" BOOLEAN NOT NULL DEFAULT false,
    "phorestSyncCron" TEXT NOT NULL DEFAULT '0 3 * * *',
    "arbzgEnabled" BOOLEAN NOT NULL DEFAULT true,
    "availabilityEnabled" BOOLEAN NOT NULL DEFAULT true,
    "vocationalSchoolAutoCleanupShifts" BOOLEAN NOT NULL DEFAULT true,
    "christmasEveRule" TEXT NOT NULL DEFAULT 'NORMAL',
    "newYearsEveRule" TEXT NOT NULL DEFAULT 'NORMAL',
    "holidayRulesValidFromYear" INTEGER,
    "vacationLeadTimeDays" INTEGER NOT NULL DEFAULT 0,
    "vacationMaxAdvanceMonths" INTEGER NOT NULL DEFAULT 0,
    "vocationalSchoolPreviewWeeks" INTEGER NOT NULL DEFAULT 13,
    "vocationalSchoolMinutesPerDay" INTEGER NOT NULL DEFAULT 480,
    "vocationalSchoolBlockMinutesPerWeek" INTEGER NOT NULL DEFAULT 2400,
    "halfDayAllowed" BOOLEAN NOT NULL DEFAULT true,
    "sickSelfReport" BOOLEAN NOT NULL DEFAULT true,
    "sickNoteRequiredAfterDays" INTEGER NOT NULL DEFAULT 3,
    "autoCalcPartTimeVacation" BOOLEAN NOT NULL DEFAULT true,
    "fullTimeWorkDaysPerWeek" INTEGER NOT NULL DEFAULT 5,
    "defaultWorkDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "enforceMinVacation" BOOLEAN NOT NULL DEFAULT true,
    "carryOverRequiresReason" BOOLEAN NOT NULL DEFAULT true,
    "vacationReminderStartMonth" INTEGER NOT NULL DEFAULT 10,
    "carryoverWarningEnabled" BOOLEAN NOT NULL DEFAULT true,
    "carryoverWarningThresholds" INTEGER[] DEFAULT ARRAY[60, 30, 14, 7]::INTEGER[],
    "emailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emailOnLeaveRequest" BOOLEAN NOT NULL DEFAULT true,
    "emailOnLeaveDecision" BOOLEAN NOT NULL DEFAULT true,
    "emailOnOvertimeWarning" BOOLEAN NOT NULL DEFAULT false,
    "emailOnMissingEntries" BOOLEAN NOT NULL DEFAULT false,
    "emailOnClockOutReminder" BOOLEAN NOT NULL DEFAULT false,
    "emailOnMonthClose" BOOLEAN NOT NULL DEFAULT true,
    "reminderPendingLeaveHours" INTEGER NOT NULL DEFAULT 48,
    "reminderUpcomingAbsenceDays" INTEGER NOT NULL DEFAULT 3,
    "reminderPendingLeaveEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reminderUpcomingAbsenceEnabled" BOOLEAN NOT NULL DEFAULT true,
    "clockOutReminderHours" INTEGER NOT NULL DEFAULT 10,
    "missingEntriesDays" INTEGER NOT NULL DEFAULT 7,
    "autoDeleteOpenHours" INTEGER NOT NULL DEFAULT 14,
    "autoBreakEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultBreakStart" VARCHAR(5),
    "defaultBreakOver6h" INTEGER NOT NULL DEFAULT 30,
    "defaultBreakOver9h" INTEGER NOT NULL DEFAULT 45,
    "consolidationGapHours" INTEGER NOT NULL DEFAULT 4,
    "overtimeCarryOverMode" TEXT NOT NULL DEFAULT 'FULL',
    "overtimeCarryOverCap" INTEGER,
    "maxNegativeBalanceMinutes" INTEGER,
    "loginMaxAttempts" INTEGER NOT NULL DEFAULT 5,
    "loginLockoutMinutes" INTEGER NOT NULL DEFAULT 15,
    "dataRetentionYears" INTEGER NOT NULL DEFAULT 10,
    "monthlyHoursHolidayDeduction" BOOLEAN NOT NULL DEFAULT false,
    "datevNormalstundenNr" INTEGER NOT NULL DEFAULT 100,
    "datevUrlaubNr" INTEGER NOT NULL DEFAULT 300,
    "datevKrankNr" INTEGER NOT NULL DEFAULT 200,
    "datevSonderurlaubNr" INTEGER NOT NULL DEFAULT 302,
    "defaultCoreStart" VARCHAR(5),
    "defaultCoreEnd" VARCHAR(5),
    "defaultCoreDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "wifiPresenceWindowMinutes" INTEGER NOT NULL DEFAULT 15,
    "storeHours" JSONB NOT NULL DEFAULT '[{"day":0,"open":"08:00","close":"20:00"},{"day":1,"open":"08:00","close":"20:00"},{"day":2,"open":"08:00","close":"20:00"},{"day":3,"open":"08:00","close":"20:00"},{"day":4,"open":"08:00","close":"20:00"},{"day":5,"open":"08:00","close":"20:00"},{"day":6,"open":"08:00","close":"20:00","closed":true}]',
    "shiftStoreHoursMode" TEXT NOT NULL DEFAULT 'DAY_ONLY',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TenantConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'EMPLOYEE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "emailNotifications" BOOLEAN NOT NULL DEFAULT true,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ,
    "uiPreferences" JSONB,
    "lastFailedLoginAt" TIMESTAMPTZ,
    "lastLoginAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "usedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "acceptedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeNumber" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "nfcCardId" TEXT,
    "wifiMacs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wifiPresenceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "wifiOptInAt" TIMESTAMPTZ,
    "avatarPath" TEXT,
    "classification" "EmployeeClassification" NOT NULL DEFAULT 'VOLLZEIT',
    "coverageWeight" DECIMAL(3,2) NOT NULL DEFAULT 1.00,
    "requiresSupervision" BOOLEAN NOT NULL DEFAULT false,
    "hireDate" TIMESTAMPTZ NOT NULL,
    "exitDate" TIMESTAMPTZ,
    "birthDate" DATE,
    "breakOver6hOverride" INTEGER,
    "breakOver9hOverride" INTEGER,
    "isTimeTrackingExempt" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkSchedule" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "ScheduleType" NOT NULL DEFAULT 'FIXED_SCHEDULE',
    "weeklyHours" DECIMAL(5,2),
    "monthlyHours" DECIMAL(5,2),
    "mondayHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "tuesdayHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "wednesdayHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "thursdayHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "fridayHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "saturdayHours" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "sundayHours" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "workDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "coreStart" TEXT,
    "coreEnd" TEXT,
    "coreDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "overtimeThreshold" DECIMAL(5,2) NOT NULL DEFAULT 60,
    "allowOvertimePayout" BOOLEAN NOT NULL DEFAULT false,
    "overtimeMode" TEXT NOT NULL DEFAULT 'CARRY_FORWARD',
    "maxNegativeBalanceMinutes" INTEGER,
    "validFrom" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "WorkSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TIMESTAMPTZ NOT NULL,
    "endTime" TIMESTAMPTZ,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "type" "TimeEntryType" NOT NULL DEFAULT 'WORK',
    "source" "TimeEntrySource" NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMPTZ,
    "isInvalid" BOOLEAN NOT NULL DEFAULT false,
    "invalidReason" TEXT,
    "deletedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Break" (
    "id" TEXT NOT NULL,
    "timeEntryId" TEXT NOT NULL,
    "startTime" TIMESTAMPTZ NOT NULL,
    "endTime" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Break_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaldoSnapshot" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodType" "SaldoPeriodType" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "workedMinutes" INTEGER NOT NULL,
    "expectedMinutes" INTEGER NOT NULL,
    "balanceMinutes" INTEGER NOT NULL,
    "carryOver" INTEGER NOT NULL,
    "closedAt" TIMESTAMPTZ NOT NULL,
    "closedBy" TEXT,
    "note" TEXT,
    "superseded" BOOLEAN NOT NULL DEFAULT false,
    "supersededReason" TEXT,

    CONSTRAINT "SaldoSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OvertimeAccount" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "balanceHours" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "OvertimeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OvertimeTransaction" (
    "id" TEXT NOT NULL,
    "overtimeAccountId" TEXT NOT NULL,
    "hours" DECIMAL(7,2) NOT NULL,
    "type" "OvertimeTransactionType" NOT NULL,
    "description" TEXT,
    "referenceMonth" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "OvertimeTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OvertimePlan" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "hoursToReduce" DECIMAL(7,2) NOT NULL,
    "deadline" TIMESTAMPTZ NOT NULL,
    "status" "OvertimePlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "OvertimePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveType" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "color" TEXT NOT NULL DEFAULT '#3B82F6',
    "allowHalfDay" BOOLEAN NOT NULL DEFAULT true,
    "maxDaysPerYear" INTEGER,
    "leadTimeDays" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveEntitlement" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "totalDays" DECIMAL(5,2) NOT NULL,
    "usedDays" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "carriedOverDays" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "carryOverDeadline" TIMESTAMPTZ,
    "carryOverReason" TEXT,
    "carryOverNote" TEXT,
    "isAutoCalculated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "LeaveEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecialLeaveRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reason" TEXT,
    "defaultDays" DECIMAL(4,2) NOT NULL DEFAULT 1,
    "isStatutory" BOOLEAN NOT NULL DEFAULT false,
    "requiresProof" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "SpecialLeaveRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "specialLeaveRuleId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "days" DECIMAL(5,2) NOT NULL,
    "halfDay" BOOLEAN NOT NULL DEFAULT false,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMPTZ,
    "reviewNote" TEXT,
    "attestPresent" BOOLEAN NOT NULL DEFAULT false,
    "attestValidFrom" DATE,
    "attestValidTo" DATE,
    "deletedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Absence" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "AbsenceType" NOT NULL,
    "source" "AbsenceSource" NOT NULL DEFAULT 'MANUAL',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "days" DECIMAL(5,2) NOT NULL,
    "note" TEXT,
    "documentPath" TEXT,
    "deletedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "Absence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicHoliday" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "federalState" "FederalState" NOT NULL,
    "year" INTEGER NOT NULL,

    CONSTRAINT "PublicHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolHolidayPeriod" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "federalState" "FederalState" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "fetchedAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolHolidayPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "purgeable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerminalApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerminalApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PresenceSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "adapterUrl" TEXT,
    "adapterSecret" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMPTZ,
    "revokedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "deletedAt" TIMESTAMPTZ,

    CONSTRAINT "PresenceSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PresenceDevice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "mac" TEXT NOT NULL,
    "label" TEXT,
    "addedByUserId" TEXT,
    "addedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PresenceDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMPTZ,
    "lastUsedAt" TIMESTAMPTZ,
    "revokedAt" TIMESTAMPTZ,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyShutdown" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "deductsFromVacation" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "CompanyShutdown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyShutdownException" (
    "id" TEXT NOT NULL,
    "shutdownId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyShutdownException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "dismissedAt" TIMESTAMPTZ,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#3B82F6',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverageRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT,
    "dayOfWeek" INTEGER NOT NULL,
    "minStaff" DECIMAL(4,2) NOT NULL DEFAULT 2,
    "requiresNonSupervised" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "CoverageRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "templateId" TEXT,
    "date" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "label" TEXT,
    "note" TEXT,
    "conflictsWithLeave" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMPTZ,
    "deletedReason" TEXT,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeShiftPattern" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "templateId" TEXT,
    "validFrom" DATE NOT NULL,
    "validUntil" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "EmployeeShiftPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeVocationalSchoolPattern" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "blockWeeks" INTEGER[],
    "blockYear" INTEGER,
    "validFrom" DATE NOT NULL,
    "validUntil" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "respectSchoolHolidays" BOOLEAN NOT NULL DEFAULT true,
    "federalStateOverride" "FederalState",
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "EmployeeVocationalSchoolPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeAvailability" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "date" DATE,
    "status" "AvailabilityStatus" NOT NULL,
    "note" VARCHAR(200),
    "validFrom" DATE NOT NULL,
    "validUntil" DATE,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "EmployeeAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "TenantConfig_tenantId_key" ON "TenantConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_token_key" ON "Invitation"("token");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_nfcCardId_key" ON "Employee"("nfcCardId");

-- CreateIndex
CREATE INDEX "Employee_tenantId_idx" ON "Employee"("tenantId");

-- CreateIndex
CREATE INDEX "Employee_userId_idx" ON "Employee"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_tenantId_employeeNumber_key" ON "Employee"("tenantId", "employeeNumber");

-- CreateIndex
CREATE INDEX "WorkSchedule_employeeId_validFrom_idx" ON "WorkSchedule"("employeeId", "validFrom");

-- CreateIndex
CREATE INDEX "TimeEntry_employeeId_date_idx" ON "TimeEntry"("employeeId", "date");

-- CreateIndex
CREATE INDEX "TimeEntry_date_idx" ON "TimeEntry"("date");

-- CreateIndex
CREATE INDEX "Break_timeEntryId_idx" ON "Break"("timeEntryId");

-- CreateIndex
CREATE INDEX "SaldoSnapshot_employeeId_idx" ON "SaldoSnapshot"("employeeId");

-- CreateIndex
CREATE INDEX "SaldoSnapshot_employeeId_periodType_idx" ON "SaldoSnapshot"("employeeId", "periodType");

-- CreateIndex
CREATE UNIQUE INDEX "SaldoSnapshot_employeeId_periodType_periodStart_key" ON "SaldoSnapshot"("employeeId", "periodType", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "OvertimeAccount_employeeId_key" ON "OvertimeAccount"("employeeId");

-- CreateIndex
CREATE INDEX "OvertimeTransaction_overtimeAccountId_idx" ON "OvertimeTransaction"("overtimeAccountId");

-- CreateIndex
CREATE INDEX "OvertimePlan_employeeId_idx" ON "OvertimePlan"("employeeId");

-- CreateIndex
CREATE INDEX "LeaveType_tenantId_idx" ON "LeaveType"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_tenantId_name_key" ON "LeaveType"("tenantId", "name");

-- CreateIndex
CREATE INDEX "LeaveEntitlement_employeeId_idx" ON "LeaveEntitlement"("employeeId");

-- CreateIndex
CREATE INDEX "LeaveEntitlement_leaveTypeId_idx" ON "LeaveEntitlement"("leaveTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveEntitlement_employeeId_leaveTypeId_year_key" ON "LeaveEntitlement"("employeeId", "leaveTypeId", "year");

-- CreateIndex
CREATE INDEX "SpecialLeaveRule_tenantId_idx" ON "SpecialLeaveRule"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SpecialLeaveRule_tenantId_name_key" ON "SpecialLeaveRule"("tenantId", "name");

-- CreateIndex
CREATE INDEX "LeaveRequest_employeeId_idx" ON "LeaveRequest"("employeeId");

-- CreateIndex
CREATE INDEX "LeaveRequest_employeeId_status_idx" ON "LeaveRequest"("employeeId", "status");

-- CreateIndex
CREATE INDEX "LeaveRequest_leaveTypeId_idx" ON "LeaveRequest"("leaveTypeId");

-- CreateIndex
CREATE INDEX "Absence_employeeId_idx" ON "Absence"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Absence_employeeId_startDate_type_key" ON "Absence"("employeeId", "startDate", "type");

-- CreateIndex
CREATE INDEX "PublicHoliday_tenantId_year_idx" ON "PublicHoliday"("tenantId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "PublicHoliday_tenantId_date_key" ON "PublicHoliday"("tenantId", "date");

-- CreateIndex
CREATE INDEX "SchoolHolidayPeriod_tenantId_federalState_startDate_idx" ON "SchoolHolidayPeriod"("tenantId", "federalState", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolHolidayPeriod_tenantId_federalState_startDate_endDate_key" ON "SchoolHolidayPeriod"("tenantId", "federalState", "startDate", "endDate", "source");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TerminalApiKey_keyHash_key" ON "TerminalApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "TerminalApiKey_tenantId_idx" ON "TerminalApiKey"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PresenceSource_keyHash_key" ON "PresenceSource"("keyHash");

-- CreateIndex
CREATE INDEX "PresenceSource_tenantId_idx" ON "PresenceSource"("tenantId");

-- CreateIndex
CREATE INDEX "PresenceSource_keyHash_idx" ON "PresenceSource"("keyHash");

-- CreateIndex
CREATE INDEX "PresenceDevice_tenantId_idx" ON "PresenceDevice"("tenantId");

-- CreateIndex
CREATE INDEX "PresenceDevice_employeeId_idx" ON "PresenceDevice"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PresenceDevice_tenantId_mac_key" ON "PresenceDevice"("tenantId", "mac");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_idx" ON "ApiKey"("tenantId");

-- CreateIndex
CREATE INDEX "CompanyShutdown_tenantId_idx" ON "CompanyShutdown"("tenantId");

-- CreateIndex
CREATE INDEX "CompanyShutdown_tenantId_startDate_idx" ON "CompanyShutdown"("tenantId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyShutdownException_shutdownId_employeeId_key" ON "CompanyShutdownException"("shutdownId", "employeeId");

-- CreateIndex
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_dismissedAt_idx" ON "Notification"("userId", "dismissedAt");

-- CreateIndex
CREATE INDEX "Notification_relatedType_relatedId_idx" ON "Notification"("relatedType", "relatedId");

-- CreateIndex
CREATE INDEX "ShiftTemplate_tenantId_idx" ON "ShiftTemplate"("tenantId");

-- CreateIndex
CREATE INDEX "CoverageRule_tenantId_idx" ON "CoverageRule"("tenantId");

-- CreateIndex
CREATE INDEX "CoverageRule_templateId_idx" ON "CoverageRule"("templateId");

-- CreateIndex
CREATE INDEX "Shift_employeeId_date_idx" ON "Shift"("employeeId", "date");

-- CreateIndex
CREATE INDEX "Shift_date_idx" ON "Shift"("date");

-- CreateIndex
CREATE INDEX "Shift_employeeId_date_deletedAt_idx" ON "Shift"("employeeId", "date", "deletedAt");

-- CreateIndex
CREATE INDEX "EmployeeShiftPattern_employeeId_idx" ON "EmployeeShiftPattern"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeShiftPattern_employeeId_dayOfWeek_validFrom_key" ON "EmployeeShiftPattern"("employeeId", "dayOfWeek", "validFrom");

-- CreateIndex
CREATE INDEX "EmployeeVocationalSchoolPattern_employeeId_isActive_idx" ON "EmployeeVocationalSchoolPattern"("employeeId", "isActive");

-- CreateIndex
CREATE INDEX "EmployeeAvailability_employeeId_idx" ON "EmployeeAvailability"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeeAvailability_employeeId_dayOfWeek_idx" ON "EmployeeAvailability"("employeeId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "EmployeeAvailability_employeeId_date_idx" ON "EmployeeAvailability"("employeeId", "date");

-- AddForeignKey
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtpToken" ADD CONSTRAINT "OtpToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Break" ADD CONSTRAINT "Break_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaldoSnapshot" ADD CONSTRAINT "SaldoSnapshot_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OvertimeAccount" ADD CONSTRAINT "OvertimeAccount_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OvertimeTransaction" ADD CONSTRAINT "OvertimeTransaction_overtimeAccountId_fkey" FOREIGN KEY ("overtimeAccountId") REFERENCES "OvertimeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OvertimePlan" ADD CONSTRAINT "OvertimePlan_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveType" ADD CONSTRAINT "LeaveType_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveEntitlement" ADD CONSTRAINT "LeaveEntitlement_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveEntitlement" ADD CONSTRAINT "LeaveEntitlement_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialLeaveRule" ADD CONSTRAINT "SpecialLeaveRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_specialLeaveRuleId_fkey" FOREIGN KEY ("specialLeaveRuleId") REFERENCES "SpecialLeaveRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Absence" ADD CONSTRAINT "Absence_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicHoliday" ADD CONSTRAINT "PublicHoliday_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolHolidayPeriod" ADD CONSTRAINT "SchoolHolidayPeriod_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalApiKey" ADD CONSTRAINT "TerminalApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresenceSource" ADD CONSTRAINT "PresenceSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresenceDevice" ADD CONSTRAINT "PresenceDevice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresenceDevice" ADD CONSTRAINT "PresenceDevice_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyShutdown" ADD CONSTRAINT "CompanyShutdown_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyShutdownException" ADD CONSTRAINT "CompanyShutdownException_shutdownId_fkey" FOREIGN KEY ("shutdownId") REFERENCES "CompanyShutdown"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyShutdownException" ADD CONSTRAINT "CompanyShutdownException_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftTemplate" ADD CONSTRAINT "ShiftTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageRule" ADD CONSTRAINT "CoverageRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageRule" ADD CONSTRAINT "CoverageRule_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ShiftTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ShiftTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeShiftPattern" ADD CONSTRAINT "EmployeeShiftPattern_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeShiftPattern" ADD CONSTRAINT "EmployeeShiftPattern_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ShiftTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeVocationalSchoolPattern" ADD CONSTRAINT "EmployeeVocationalSchoolPattern_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeAvailability" ADD CONSTRAINT "EmployeeAvailability_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
