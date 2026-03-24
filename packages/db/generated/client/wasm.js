
Object.defineProperty(exports, "__esModule", { value: true });

const {
  Decimal,
  objectEnumValues,
  makeStrictEnum,
  Public,
  getRuntime,
  skip
} = require('./runtime/index-browser.js')


const Prisma = {}

exports.Prisma = Prisma
exports.$Enums = {}

/**
 * Prisma Client JS version: 5.22.0
 * Query Engine version: 605197351a3c8bdd595af2d2a9bc3025bca48ea2
 */
Prisma.prismaVersion = {
  client: "5.22.0",
  engine: "605197351a3c8bdd595af2d2a9bc3025bca48ea2"
}

Prisma.PrismaClientKnownRequestError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientKnownRequestError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)};
Prisma.PrismaClientUnknownRequestError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientUnknownRequestError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientRustPanicError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientRustPanicError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientInitializationError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientInitializationError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientValidationError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientValidationError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.NotFoundError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`NotFoundError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.Decimal = Decimal

/**
 * Re-export of sql-template-tag
 */
Prisma.sql = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`sqltag is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.empty = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`empty is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.join = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`join is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.raw = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`raw is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.validator = Public.validator

/**
* Extensions
*/
Prisma.getExtensionContext = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`Extensions.getExtensionContext is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.defineExtension = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`Extensions.defineExtension is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}

/**
 * Shorthand utilities for JSON filtering
 */
Prisma.DbNull = objectEnumValues.instances.DbNull
Prisma.JsonNull = objectEnumValues.instances.JsonNull
Prisma.AnyNull = objectEnumValues.instances.AnyNull

Prisma.NullTypes = {
  DbNull: objectEnumValues.classes.DbNull,
  JsonNull: objectEnumValues.classes.JsonNull,
  AnyNull: objectEnumValues.classes.AnyNull
}



/**
 * Enums
 */

exports.Prisma.TransactionIsolationLevel = makeStrictEnum({
  ReadUncommitted: 'ReadUncommitted',
  ReadCommitted: 'ReadCommitted',
  RepeatableRead: 'RepeatableRead',
  Serializable: 'Serializable'
});

exports.Prisma.TenantScalarFieldEnum = {
  id: 'id',
  name: 'name',
  slug: 'slug',
  federalState: 'federalState',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.TenantConfigScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  defaultWeeklyHours: 'defaultWeeklyHours',
  defaultMondayHours: 'defaultMondayHours',
  defaultTuesdayHours: 'defaultTuesdayHours',
  defaultWednesdayHours: 'defaultWednesdayHours',
  defaultThursdayHours: 'defaultThursdayHours',
  defaultFridayHours: 'defaultFridayHours',
  defaultSaturdayHours: 'defaultSaturdayHours',
  defaultSundayHours: 'defaultSundayHours',
  overtimeThreshold: 'overtimeThreshold',
  allowOvertimePayout: 'allowOvertimePayout',
  defaultVacationDays: 'defaultVacationDays',
  carryOverDeadlineDay: 'carryOverDeadlineDay',
  carryOverDeadlineMonth: 'carryOverDeadlineMonth',
  smtpHost: 'smtpHost',
  smtpPort: 'smtpPort',
  smtpUser: 'smtpUser',
  smtpPassword: 'smtpPassword',
  smtpFromEmail: 'smtpFromEmail',
  smtpFromName: 'smtpFromName',
  smtpSecure: 'smtpSecure',
  twoFaEnabled: 'twoFaEnabled',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.UserScalarFieldEnum = {
  id: 'id',
  email: 'email',
  passwordHash: 'passwordHash',
  role: 'role',
  isActive: 'isActive',
  lastLoginAt: 'lastLoginAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.RefreshTokenScalarFieldEnum = {
  id: 'id',
  token: 'token',
  userId: 'userId',
  expiresAt: 'expiresAt',
  createdAt: 'createdAt',
  revokedAt: 'revokedAt'
};

exports.Prisma.OtpTokenScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  code: 'code',
  expiresAt: 'expiresAt',
  usedAt: 'usedAt',
  createdAt: 'createdAt'
};

exports.Prisma.InvitationScalarFieldEnum = {
  id: 'id',
  token: 'token',
  employeeId: 'employeeId',
  email: 'email',
  expiresAt: 'expiresAt',
  acceptedAt: 'acceptedAt',
  createdAt: 'createdAt'
};

exports.Prisma.EmployeeScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  userId: 'userId',
  employeeNumber: 'employeeNumber',
  firstName: 'firstName',
  lastName: 'lastName',
  nfcCardId: 'nfcCardId',
  hireDate: 'hireDate',
  exitDate: 'exitDate',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.WorkScheduleScalarFieldEnum = {
  id: 'id',
  employeeId: 'employeeId',
  weeklyHours: 'weeklyHours',
  mondayHours: 'mondayHours',
  tuesdayHours: 'tuesdayHours',
  wednesdayHours: 'wednesdayHours',
  thursdayHours: 'thursdayHours',
  fridayHours: 'fridayHours',
  saturdayHours: 'saturdayHours',
  sundayHours: 'sundayHours',
  overtimeThreshold: 'overtimeThreshold',
  allowOvertimePayout: 'allowOvertimePayout',
  validFrom: 'validFrom',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.TimeEntryScalarFieldEnum = {
  id: 'id',
  employeeId: 'employeeId',
  date: 'date',
  startTime: 'startTime',
  endTime: 'endTime',
  breakMinutes: 'breakMinutes',
  type: 'type',
  source: 'source',
  note: 'note',
  isLocked: 'isLocked',
  lockedAt: 'lockedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  createdBy: 'createdBy'
};

exports.Prisma.OvertimeAccountScalarFieldEnum = {
  id: 'id',
  employeeId: 'employeeId',
  balanceHours: 'balanceHours',
  updatedAt: 'updatedAt'
};

exports.Prisma.OvertimeTransactionScalarFieldEnum = {
  id: 'id',
  overtimeAccountId: 'overtimeAccountId',
  hours: 'hours',
  type: 'type',
  description: 'description',
  referenceMonth: 'referenceMonth',
  createdAt: 'createdAt',
  createdBy: 'createdBy'
};

exports.Prisma.OvertimePlanScalarFieldEnum = {
  id: 'id',
  employeeId: 'employeeId',
  hoursToReduce: 'hoursToReduce',
  deadline: 'deadline',
  status: 'status',
  note: 'note',
  createdAt: 'createdAt',
  createdBy: 'createdBy'
};

exports.Prisma.LeaveTypeScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  name: 'name',
  isPaid: 'isPaid',
  requiresApproval: 'requiresApproval',
  color: 'color',
  createdAt: 'createdAt'
};

exports.Prisma.LeaveEntitlementScalarFieldEnum = {
  id: 'id',
  employeeId: 'employeeId',
  leaveTypeId: 'leaveTypeId',
  year: 'year',
  totalDays: 'totalDays',
  usedDays: 'usedDays',
  carriedOverDays: 'carriedOverDays',
  carryOverDeadline: 'carryOverDeadline',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.LeaveRequestScalarFieldEnum = {
  id: 'id',
  employeeId: 'employeeId',
  leaveTypeId: 'leaveTypeId',
  startDate: 'startDate',
  endDate: 'endDate',
  days: 'days',
  halfDay: 'halfDay',
  status: 'status',
  note: 'note',
  reviewedBy: 'reviewedBy',
  reviewedAt: 'reviewedAt',
  reviewNote: 'reviewNote',
  attestPresent: 'attestPresent',
  attestValidFrom: 'attestValidFrom',
  attestValidTo: 'attestValidTo',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.AbsenceScalarFieldEnum = {
  id: 'id',
  employeeId: 'employeeId',
  type: 'type',
  startDate: 'startDate',
  endDate: 'endDate',
  days: 'days',
  note: 'note',
  documentPath: 'documentPath',
  createdAt: 'createdAt',
  createdBy: 'createdBy'
};

exports.Prisma.PublicHolidayScalarFieldEnum = {
  id: 'id',
  tenantId: 'tenantId',
  date: 'date',
  name: 'name',
  federalState: 'federalState',
  year: 'year'
};

exports.Prisma.AuditLogScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  action: 'action',
  entity: 'entity',
  entityId: 'entityId',
  oldValue: 'oldValue',
  newValue: 'newValue',
  ipAddress: 'ipAddress',
  userAgent: 'userAgent',
  createdAt: 'createdAt'
};

exports.Prisma.SortOrder = {
  asc: 'asc',
  desc: 'desc'
};

exports.Prisma.NullableJsonNullValueInput = {
  DbNull: Prisma.DbNull,
  JsonNull: Prisma.JsonNull
};

exports.Prisma.QueryMode = {
  default: 'default',
  insensitive: 'insensitive'
};

exports.Prisma.NullsOrder = {
  first: 'first',
  last: 'last'
};

exports.Prisma.JsonNullValueFilter = {
  DbNull: Prisma.DbNull,
  JsonNull: Prisma.JsonNull,
  AnyNull: Prisma.AnyNull
};
exports.FederalState = exports.$Enums.FederalState = {
  NIEDERSACHSEN: 'NIEDERSACHSEN',
  BAYERN: 'BAYERN',
  BERLIN: 'BERLIN',
  BRANDENBURG: 'BRANDENBURG',
  BREMEN: 'BREMEN',
  HAMBURG: 'HAMBURG',
  HESSEN: 'HESSEN',
  MECKLENBURG_VORPOMMERN: 'MECKLENBURG_VORPOMMERN',
  NORDRHEIN_WESTFALEN: 'NORDRHEIN_WESTFALEN',
  RHEINLAND_PFALZ: 'RHEINLAND_PFALZ',
  SAARLAND: 'SAARLAND',
  SACHSEN: 'SACHSEN',
  SACHSEN_ANHALT: 'SACHSEN_ANHALT',
  SCHLESWIG_HOLSTEIN: 'SCHLESWIG_HOLSTEIN',
  THUERINGEN: 'THUERINGEN',
  BADEN_WUERTTEMBERG: 'BADEN_WUERTTEMBERG'
};

exports.Role = exports.$Enums.Role = {
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  EMPLOYEE: 'EMPLOYEE'
};

exports.TimeEntryType = exports.$Enums.TimeEntryType = {
  WORK: 'WORK',
  OVERTIME: 'OVERTIME',
  PUBLIC_HOLIDAY: 'PUBLIC_HOLIDAY'
};

exports.TimeEntrySource = exports.$Enums.TimeEntrySource = {
  NFC: 'NFC',
  MOBILE: 'MOBILE',
  MANUAL: 'MANUAL',
  CORRECTION: 'CORRECTION'
};

exports.OvertimeTransactionType = exports.$Enums.OvertimeTransactionType = {
  ACCRUAL: 'ACCRUAL',
  REDUCTION: 'REDUCTION',
  PAYOUT: 'PAYOUT',
  CORRECTION: 'CORRECTION'
};

exports.OvertimePlanStatus = exports.$Enums.OvertimePlanStatus = {
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
};

exports.LeaveRequestStatus = exports.$Enums.LeaveRequestStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  CANCELLATION_REQUESTED: 'CANCELLATION_REQUESTED'
};

exports.AbsenceType = exports.$Enums.AbsenceType = {
  SICK: 'SICK',
  SICK_CHILD: 'SICK_CHILD',
  SPECIAL_LEAVE: 'SPECIAL_LEAVE',
  UNPAID_LEAVE: 'UNPAID_LEAVE',
  OTHER: 'OTHER'
};

exports.Prisma.ModelName = {
  Tenant: 'Tenant',
  TenantConfig: 'TenantConfig',
  User: 'User',
  RefreshToken: 'RefreshToken',
  OtpToken: 'OtpToken',
  Invitation: 'Invitation',
  Employee: 'Employee',
  WorkSchedule: 'WorkSchedule',
  TimeEntry: 'TimeEntry',
  OvertimeAccount: 'OvertimeAccount',
  OvertimeTransaction: 'OvertimeTransaction',
  OvertimePlan: 'OvertimePlan',
  LeaveType: 'LeaveType',
  LeaveEntitlement: 'LeaveEntitlement',
  LeaveRequest: 'LeaveRequest',
  Absence: 'Absence',
  PublicHoliday: 'PublicHoliday',
  AuditLog: 'AuditLog'
};

/**
 * This is a stub Prisma Client that will error at runtime if called.
 */
class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        let message
        const runtime = getRuntime()
        if (runtime.isEdge) {
          message = `PrismaClient is not configured to run in ${runtime.prettyName}. In order to run Prisma Client on edge runtime, either:
- Use Prisma Accelerate: https://pris.ly/d/accelerate
- Use Driver Adapters: https://pris.ly/d/driver-adapters
`;
        } else {
          message = 'PrismaClient is unable to run in this browser environment, or has been bundled for the browser (running in `' + runtime.prettyName + '`).'
        }
        
        message += `
If this is unexpected, please open an issue: https://pris.ly/prisma-prisma-bug-report`

        throw new Error(message)
      }
    })
  }
}

exports.PrismaClient = PrismaClient

Object.assign(exports, Prisma)
