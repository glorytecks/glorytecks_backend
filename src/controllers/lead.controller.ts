import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/ApiResponse';
import { parseListParams, buildPaginationMeta, toSortSpecs } from '../utils/queryFeatures';
import { ApiError } from '../utils/ApiError';
import { ALL_LEAD_STATUS, CHAT_STEPS, LeadStatus } from '../constants';
import { demoRequestRepo, contactEnquiryRepo, chatEnquiryRepo, BaseRepository } from '../repositories';
import { IDemoRequest, IContactEnquiry, IChatEnquiry } from '../interfaces/common';
import { invalidateDashboard } from '../lib/cacheInvalidation';

/** Factory producing handlers for a lead-style resource (demo / contact). */
function leadHandlers<T>(repo: BaseRepository<T>, label: string, searchable: string[]) {
  return {
    list: asyncHandler(async (req: Request, res: Response) => {
      const params = parseListParams(req.query as Record<string, unknown>, ['status', 'course']);
      const { items, total } = await repo.list({
        filter: params.filters,
        search: params.search,
        searchableFields: searchable,
        sort: toSortSpecs(params.sort),
        page: params.page,
        limit: params.limit,
      });
      const meta = buildPaginationMeta(total, params.page, params.limit);
      return sendSuccess(res, items, `${label} fetched`, 200, meta);
    }),

    getById: asyncHandler(async (req: Request, res: Response) => {
      const doc = await repo.findById(req.params.id);
      if (!doc) throw ApiError.notFound(`${label} not found`);
      return sendSuccess(res, doc, `${label} fetched`);
    }),

    updateStatus: asyncHandler(async (req: Request, res: Response) => {
      const { status, notes } = req.body as { status?: LeadStatus; notes?: string };
      if (status && !ALL_LEAD_STATUS.includes(status)) throw ApiError.badRequest('Invalid status');
      const update: Record<string, unknown> = {};
      if (status) update.status = status;
      if (notes !== undefined) update.notes = notes;

      const doc = await repo.updateById(req.params.id, update);
      if (!doc) throw ApiError.notFound(`${label} not found`);
      await invalidateDashboard();
      return sendSuccess(res, doc, `${label} updated`);
    }),

    remove: asyncHandler(async (req: Request, res: Response) => {
      const deleted = await repo.deleteById(req.params.id);
      if (!deleted) throw ApiError.notFound(`${label} not found`);
      await invalidateDashboard();
      return sendNoContent(res);
    }),
  };
}

export const demoRequestController = {
  ...leadHandlers<IDemoRequest>(demoRequestRepo, 'Demo request', ['name', 'phone', 'course']),
  /** Public endpoint: the website posts new demo bookings here. */
  create: asyncHandler(async (req: Request, res: Response) => {
    const { name, phone, course, source } = req.body as Record<string, string>;
    const doc = await demoRequestRepo.insert({ name, phone, course, source });
    await invalidateDashboard();
    return sendCreated(res, { id: doc.id }, 'Demo request received');
  }),
};

export const contactEnquiryController = {
  ...leadHandlers<IContactEnquiry>(contactEnquiryRepo, 'Enquiry', [
    'name',
    'email',
    'course',
    'message',
  ]),
  /** Public endpoint: the website posts contact form submissions here. */
  create: asyncHandler(async (req: Request, res: Response) => {
    const { name, email, phone, course, message, subject } = req.body as Record<string, string>;
    const doc = await contactEnquiryRepo.insert({
      name,
      // The column carries a `email = lower(email)` CHECK, matching the old
      // Mongoose `lowercase: true`.
      email: String(email ?? '').toLowerCase(),
      phone,
      course,
      message,
      subject,
    });
    await invalidateDashboard();
    return sendCreated(res, { id: doc.id }, 'Enquiry received');
  }),
};

/**
 * A chat can be continued for this long after it was opened. The record id is
 * the only credential the public update route has, so it is not left usable
 * indefinitely.
 */
const CHAT_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const chatEnquiryController = {
  ...leadHandlers<IChatEnquiry>(chatEnquiryRepo, 'Chat enquiry', [
    'name',
    'phone',
    'email',
    'course',
  ]),

  /** Public: the chat widget opens a record when the visitor gives their name. */
  create: asyncHandler(async (req: Request, res: Response) => {
    const { name, pageUrl } = req.body as Record<string, string>;
    const doc = await chatEnquiryRepo.insert({ name, pageUrl, step: 'name' });
    await invalidateDashboard();
    return sendCreated(res, { id: doc.id }, 'Chat started');
  }),

  /** Public: the widget saves each later answer against the record it opened. */
  publicUpdate: asyncHandler(async (req: Request, res: Response) => {
    const doc = await chatEnquiryRepo.findById(req.params.id);
    // Unknown and expired look the same, so ids cannot be probed.
    if (
      !doc ||
      Date.now() - new Date(doc.createdAt as unknown as string).getTime() > CHAT_EDIT_WINDOW_MS
    ) {
      throw ApiError.notFound('Chat not found');
    }

    const body = req.body as Record<string, string | undefined>;
    const update: Record<string, unknown> = {};
    for (const key of ['course', 'phone', 'email', 'profile', 'mode'] as const) {
      const value = body[key];
      if (typeof value === 'string' && value.trim()) update[key] = value.trim();
    }
    // The step only ever moves forward, so a late or replayed request cannot
    // make a finished chat look unfinished.
    const next = CHAT_STEPS.indexOf(body.step as (typeof CHAT_STEPS)[number]);
    if (body.step && next > CHAT_STEPS.indexOf(doc.step)) {
      update.step = body.step;
    }

    await chatEnquiryRepo.updateById(req.params.id, update);
    await invalidateDashboard();
    return sendSuccess(res, { id: req.params.id }, 'Chat updated');
  }),
};
