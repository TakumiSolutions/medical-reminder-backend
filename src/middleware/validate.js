import { badRequest } from '../utils/errors.js';

const formatIssues = (issues) =>
  issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));

/**
 * Validates and replaces request parts with their parsed values.
 * Usage: validate({ body: schema, params: schema, query: schema })
 * Parsed query values are exposed as req.validatedQuery (req.query is read-only in Express 5).
 */
export function validate(schemas) {
  return (req, _res, next) => {
    for (const [part, schema] of Object.entries(schemas)) {
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        return next(badRequest('Validation failed.', formatIssues(result.error.issues)));
      }
      if (part === 'query') req.validatedQuery = result.data;
      else req[part] = result.data;
    }
    next();
  };
}
