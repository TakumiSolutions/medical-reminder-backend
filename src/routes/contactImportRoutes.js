import { Router } from 'express';
import multer from 'multer';
import { PERMISSIONS } from '../config/permissions.js';
import * as contactImportController from '../controllers/contactImportController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { MAX_FILE_BYTES } from '../services/contactImport/parseFile.js';
import {
  importIdParamsSchema,
  listImportRowsQuerySchema,
  listImportsQuerySchema,
  uploadImportBodySchema,
} from '../validators/contactImportValidators.js';

// Files are parsed in memory and never written to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5 },
});
const byId = validate({ params: importIdParamsSchema });

export const contactImportRoutes = Router();

contactImportRoutes.use(authenticate, requirePermission(PERMISSIONS.CONTACT_IMPORTS_MANAGE));

contactImportRoutes.get('/template.csv', contactImportController.template);
contactImportRoutes.get('/', validate({ query: listImportsQuerySchema }), contactImportController.list);
contactImportRoutes.post(
  '/',
  upload.single('file'),
  validate({ body: uploadImportBodySchema }),
  contactImportController.upload,
);
contactImportRoutes.get('/:id', byId, contactImportController.get);
contactImportRoutes.get('/:id/rows', byId, validate({ query: listImportRowsQuerySchema }), contactImportController.rows);
contactImportRoutes.post('/:id/commit', byId, contactImportController.commit);
contactImportRoutes.post('/:id/cancel', byId, contactImportController.cancel);
