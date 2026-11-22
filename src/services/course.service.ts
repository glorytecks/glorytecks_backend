import { courseRepo, courseCategoryRepo } from '../repositories';
import { ICourse } from '../interfaces/common';
import { CrudService } from './CrudService';
import { uniqueSlug } from '../utils/slug';
import { ApiError } from '../utils/ApiError';
import { toSlug } from '../utils/slug';

/** Course service — generic CRUD plus slug generation and the trainer join. */
class CourseService extends CrudService<ICourse> {
  constructor() {
    super(courseRepo, {
      searchableFields: ['title', 'tagline', 'description', 'category'],
      uniqueField: 'slug',
      withRelations: true,
      defaultSort: { order: 1, title: 1 },
      listFields: ['slug', 'title', 'category', 'duration', 'status', 'featured', 'order', 'createdAt', 'updatedAt'],
    });
  }

  private slugExists = async (candidate: string, excludeId?: string): Promise<boolean> => {
    const foundId = await courseRepo.exists({ slug: candidate });
    return Boolean(foundId && foundId !== excludeId);
  };

  private async normalizeCategory(
    category: unknown,
  ): Promise<string | undefined> {
    if (typeof category !== 'string') {
      return undefined;
    }

    const value = category.trim();

    if (!value) {
      return undefined;
    }

    // The admin form submits the category's display name. Match that first —
    // a category's stored slug can differ from toSlug(name) (e.g. "Cloud &
    // DevOps" saved as "cloud-devops"), so a slug-only lookup would miss it.
    const categoryDoc =
      (await courseCategoryRepo.findOne({ name: value })) ??
      (await courseCategoryRepo.findOne({ slug: toSlug(value) }));

    if (!categoryDoc) {
      throw ApiError.badRequest(
        'Please select a valid course category',
      );
    }

    if (!categoryDoc.isActive) {
      throw ApiError.badRequest(
        'The selected course category is inactive',
      );
    }

    return categoryDoc.name;
  }

  async createCourse(
    payload: Partial<ICourse>,
  ): Promise<ICourse> {
    if (!payload.title) {
      throw ApiError.badRequest(
        'Title is required',
      );
    }

    const category =
      await this.normalizeCategory(
        payload.category,
      );

    if (!category) {
      throw ApiError.badRequest(
        'Course category is required',
      );
    }

    const slug = await uniqueSlug(
      payload.slug || payload.title,
      (c) => this.slugExists(c),
    );

    const created = await courseRepo.insert({
      ...payload,
      category,
      slug,
    });

    return this.getById(String(created.id));
  }

  async updateCourse(id: string, payload: Partial<ICourse>): Promise<ICourse> {
    const doc = await courseRepo.findById(id);
    if (!doc) throw ApiError.notFound('Course not found');

    const update: Record<string, unknown> = {
      ...payload,
    };

    if (payload.category !== undefined) {
      update.category =
        await this.normalizeCategory(
          payload.category,
        );
    }

    if (
      payload.slug && 
      payload.slug !== doc.slug
    ) {
      update.slug = await uniqueSlug(
        payload.slug,
        (c) => this.slugExists(c, id),
      );
    }

    const saved = await courseRepo.updateById(id, update);
    if (!saved) throw ApiError.notFound('Course not found');
    return this.getById(id);
  }
}

export const courseService = new CourseService();
