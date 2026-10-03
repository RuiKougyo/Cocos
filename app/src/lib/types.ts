export type PeriodStatus = 'draft' | 'open' | 'closed';
export type MemberStatus = 'pending' | 'active' | 'retired';

export interface Period {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  deadline: string | null;
  status: PeriodStatus;
  view_start_min: number;
  view_end_min: number;
}

export interface DayEntry {
  work_date: string;
  is_available: boolean;
  start_min: number | null;
  end_min: number | null;
  note: string | null;
}

export interface Submission {
  member_id: string;
  note: string | null;
  updated_at: string;
  days: DayEntry[];
}

export interface Assignment {
  member_id: string;
  work_date: string;
  start_min: number;
  end_min: number;
}

export interface Member {
  id: string;
  display_name: string;
  role: 'admin' | 'staff';
  status: MemberStatus;
  sort_order: number;
  created_at: string;
  approved_at: string | null;
  retired_at: string | null;
  locked_until: string | null;
}

/** スタッフ自身の状態 */
export interface StaffMe {
  member_id: string;
  display_name: string;
  status: MemberStatus;
  store_name: string;
}

/** 代わり探しボードの 1 行（名前と時間帯だけ） */
export interface BoardRow {
  member_id: string;
  display_name: string;
  sort_order: number;
  is_me: boolean;
  work_date: string;
  avail_start: number | null;
  avail_end: number | null;
  assign_start: number | null;
  assign_end: number | null;
}

export interface Feedback {
  id: string;
  body: string;
  created_at: string;
}

export type RegisterResult = 'pending' | 'name_taken' | 'already_linked' | 'invalid_code' | 'too_many_pending';
export type LoginResult = 'ok' | 'pending' | 'locked' | 'invalid' | 'already_linked' | 'invalid_code';

export interface StaffApi {
  /** URL を開いた端末のセッションを用意する（匿名サインイン） */
  ensureSession(captchaToken?: string): Promise<void>;
  storeByCode(code: string): Promise<string | null>;
  register(code: string, name: string, pin: string): Promise<RegisterResult>;
  login(code: string, name: string, pin: string): Promise<LoginResult>;
  logout(): Promise<void>;
  me(): Promise<StaffMe | null>;
  periods(): Promise<Period[]>;
  mySubmission(periodId: string): Promise<Submission | null>;
  submitShift(periodId: string, note: string, days: DayEntry[]): Promise<void>;
  submitFeedback(body: string): Promise<void>;
  board(periodId: string): Promise<BoardRow[]>;
}

export type AdminSignIn = { next: 'mfa' } | { next: 'enroll'; qr: string; secret: string } | { next: 'done' };

export interface AdminMe {
  member_id: string;
  display_name: string;
  store_id: string;
  store_name: string;
}

export interface TimelineData {
  members: Member[];
  submissions: Submission[];
  assignments: Assignment[];
}

export interface AdminApi {
  /** 既存セッションの確認。MFA 未完了なら 'mfa' */
  session(): Promise<'none' | 'mfa' | 'ok'>;
  signIn(email: string, password: string): Promise<AdminSignIn>;
  verifyMfa(code: string): Promise<void>;
  signOut(): Promise<void>;
  me(): Promise<AdminMe | null>;
  createStore(storeName: string, displayName: string): Promise<void>;

  periods(): Promise<Period[]>;
  createPeriod(p: Omit<Period, 'id' | 'status'>): Promise<void>;
  setPeriodStatus(id: string, status: PeriodStatus): Promise<void>;
  deletePeriod(id: string): Promise<void>;

  timeline(periodId: string): Promise<TimelineData>;
  setAssignment(periodId: string, a: Assignment): Promise<void>;
  removeAssignment(memberId: string, workDate: string): Promise<void>;
  unsubmitted(periodId: string): Promise<{ member_id: string; display_name: string }[]>;
  feedback(): Promise<Feedback[]>;

  members(): Promise<Member[]>;
  approve(id: string): Promise<void>;
  reject(id: string): Promise<void>;
  resetLogin(id: string): Promise<void>;
  retire(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  deleteNow(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  joinCode(): Promise<string>;
  rotateJoinCode(): Promise<string>;
}
