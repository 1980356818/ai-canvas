export interface ChatResponse {
  content?: string;
}

export interface FunctionSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
