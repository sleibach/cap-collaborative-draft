export interface ValidationResult {
    valid: boolean;
    issues: string[];
}
/**
 * Validates that the draft is in a consistent state before activation.
 * Checks for any remaining field lock conflicts.
 */
export declare function validateBeforeActivation(draftUUID: string): Promise<ValidationResult>;
/**
 * Cleans up all collaborative draft artifacts after activation or full cancellation.
 */
export declare function cleanup(draftUUID: string): Promise<void>;
