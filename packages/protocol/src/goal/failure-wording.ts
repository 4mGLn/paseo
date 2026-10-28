/**
 * How the daemon words a failed run or a failed goal. The daemon writes these into the log;
 * the diagnosis and the Manager read them back, so both sides import them from here.
 */

/** Start of the error a run that hit its turn time limit fails with. */
export const TURN_TIMEOUT_PREFIX = "Turn timed out after";

/** Start of the error a run the Lead stopped from a check-in fails with. */
export const LEAD_STOP_PREFIX = "Stopped by the Lead:";

/** The error of a run whose agent was canceled. */
export const RUN_CANCELED_TEXT = "Agent run was canceled";

/** How each pending-request failure starts. */
export const PENDING_QUESTION_PREFIX = "Agent asked a question";
export const PENDING_PERMISSION_PREFIX = "Agent is waiting for permission";
/** The wording before requests were described; older logs carry it. */
export const LEGACY_PERMISSION_FAILURE =
  "Agent is waiting for a permission approval; unattended runs cannot continue";

/** True for a run that stopped because its agent asked something nobody could answer. */
export function isPendingRequestFailure(error: string | null | undefined): boolean {
  return (
    !!error &&
    (error.startsWith(PENDING_QUESTION_PREFIX) ||
      error.startsWith(PENDING_PERMISSION_PREFIX) ||
      error.startsWith(LEGACY_PERMISSION_FAILURE))
  );
}

/** Goal failure reasons the deadline timer writes: `Time limit of <n> minutes reached`. */
export const TIME_LIMIT_REACHED_PREFIX = "Time limit of";
/** `Deadline <deadlineAt> reached`. */
export const DEADLINE_REACHED_PATTERN = /^Deadline .* reached/;

/** Goal failure reasons for work that could not be captured for review. */
export const CAPTURE_FAILED_PREFIX = "Could not capture changes";
export const WORK_NOT_RECOVERED_PREFIX = "Could not recover the work of task";

/**
 * Goal failure reason when the verifier judged criteria and found some unmet:
 * `Acceptance criteria not met: <criterion> (<evidence>); ...`. Any other reason of a goal whose
 * tasks all succeeded (`Verification failed: ...`, a time limit or deadline) means the
 * unverified criteria were never judged.
 */
export const VERIFICATION_NOT_MET_PREFIX = "Acceptance criteria not met:";

export function isCriteriaNotMetFailure(reason: string | null | undefined): boolean {
  return !!reason && reason.startsWith(VERIFICATION_NOT_MET_PREFIX);
}

/** Goal failure reason when the daemon could not resume the goal after a restart. */
export const RESUME_FAILED_PREFIX = "Recovery failed";
