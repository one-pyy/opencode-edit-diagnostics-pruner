import { pruneDiagnostics } from './filter.mjs';

export default async function EditDiagnosticsPruner({ directory }) {
  return {
    'tool.execute.after': async (input, output) => {
      const result = pruneDiagnostics(input.tool, input.args, output.metadata, directory);
      if (result.removedFiles) output.metadata = result.metadata;
    },
  };
}
