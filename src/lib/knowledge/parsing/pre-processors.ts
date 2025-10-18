// PostProcessor type definition
export type PostProcessor = {
  name: string;
  label: string;
  description: string;
  execute: (input: {
    text: string;
    organisationId: string;
  }) => Promise<{ text: string }>;
};

// Registry for post processors
const postProcessorRegistry: Record<string, PostProcessor> = {};

/**
 * Register a post processor. Should be called at app start.
 */
export function registerPostProcessor(processor: PostProcessor) {
  if (postProcessorRegistry[processor.name]) {
    throw new Error(
      `Post processor with name '${processor.name}' already registered.`
    );
  }
  postProcessorRegistry[processor.name] = processor;
}

/**
 * Get all registered post processors (read-only)
 */
export function getAllPostProcessors(): Omit<PostProcessor, "execute">[] {
  // Do not expose the execute function in the API
  return Object.values(postProcessorRegistry).map(
    ({ execute, ...rest }) => rest
  );
}

/**
 * Apply post processors by name in order to the text
 */
export async function applyPostProcessors(
  text: string,
  organisationId: string,
  processorNames?: string[]
): Promise<string> {
  if (!processorNames || processorNames.length === 0) {
    return text;
  }

  let result = text;
  for (const name of processorNames) {
    const processor = postProcessorRegistry[name];
    if (!processor) {
      throw new Error(`Post processor '${name}' is not registered.`);
    }
    const processed = await processor.execute({
      text: result,
      organisationId: organisationId,
    });
    result = processed.text;
  }
  return result;
}
