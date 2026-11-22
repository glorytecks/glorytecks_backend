import { Router, Request, Response } from 'express';
import authRoutes from './auth.routes';
import dashboardRoutes from './dashboard.routes';
import blogRoutes from './blog.routes';
import courseRoutes from './course.routes';
import uploadRoutes from './upload.routes';
import settingsRoutes from './settings.routes';
import aboutRoutes from './about.routes';
import adminUserRoutes from './adminUser.routes';
import pageSeoRoutes from './pageSeo.routes';
import siteAuditRoutes from './siteAudit.routes';
import analyticsRoutes from './analytics.routes';
import { demoRouter, contactRouter, chatRouter } from './lead.routes';
import { buildGenericRoutes } from './generic.routes';
import publicRoutes from './public.routes';

const router = Router();

// Health check.
router.get('/health', (_req: Request, res: Response) => {
  res.json({ success: true, message: 'GloryTecks Admin API is healthy', timestamp: new Date().toISOString() });
});

// Public (website-facing) read API + form submissions.
router.use('/public', publicRoutes);

// Admin (authenticated) API.
router.use('/auth', authRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/blogs', blogRoutes);
router.use('/courses', courseRoutes);
router.use('/demo-requests', demoRouter);
router.use('/enquiries', contactRouter);
router.use('/chat-enquiries', chatRouter);
router.use('/uploads', uploadRoutes);
router.use('/settings', settingsRoutes);
router.use('/about', aboutRoutes);
router.use('/admins', adminUserRoutes);
router.use('/page-seo', pageSeoRoutes);
router.use('/seo-audit', siteAuditRoutes);
router.use('/analytics', analyticsRoutes);

// Generic CRUD resources (categories, authors, trainers, testimonials, …).
router.use('/', buildGenericRoutes());

export default router;
