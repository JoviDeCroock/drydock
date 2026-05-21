export declare const packageName = "@pracht/experiments";

export interface ExperimentFlag {
  name: string;
  enabled: boolean;
}

export declare function listExperiments(): ExperimentFlag[];
export declare function isExperimentEnabled(name: string): boolean;
export declare function describeExperiment(name: string): string;
