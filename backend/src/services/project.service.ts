import { prisma } from '../db/prisma.js';
import { AppError } from '../utils/app-error.js';
import type {
  CreateProjectInput,
  ListProjectsQuery,
  UpdateProjectInput,
} from '../validators/project.validators.js';

const PROJECT_SELECT = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Every read/write in this service scopes by BOTH id and ownerId at the
 * database layer (NFR-13/FR-57): a project that exists but belongs to someone
 * else is indistinguishable from one that does not exist (404, never 403).
 */

export async function createProject(ownerId: string, input: CreateProjectInput) {
  return prisma.project.create({
    data: { userId: ownerId, name: input.name, description: input.description ?? null },
    select: PROJECT_SELECT,
  });
}

export async function listProjects(ownerId: string, query: ListProjectsQuery) {
  const where = { userId: ownerId, deletedAt: null };

  const [totalItems, items] = await prisma.$transaction([
    prisma.project.count({ where }),
    prisma.project.findMany({
      where,
      select: PROJECT_SELECT,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return {
    items,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / query.pageSize),
    },
  };
}

export async function getOwnedProject(ownerId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId: ownerId, deletedAt: null },
    select: PROJECT_SELECT,
  });
  if (!project) {
    throw AppError.notFound('Project not found');
  }
  return project;
}

export async function updateProject(ownerId: string, projectId: string, input: UpdateProjectInput) {
  // updateMany carries the ownership predicate INTO the write (race-safe);
  // only name/description are ever written — protected fields are untouchable.
  const result = await prisma.project.updateMany({
    where: { id: projectId, userId: ownerId, deletedAt: null },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
  });
  if (result.count === 0) {
    throw AppError.notFound('Project not found');
  }
  return getOwnedProject(ownerId, projectId);
}

export interface ProjectDeletionSummary {
  apiKeysRevoked: number;
  endpointsDeactivated: number;
  pendingDeliveriesCancelled: number;
}

/**
 * Approved project-deletion cascade (frozen design) as ONE atomic transaction:
 *   1. projects.deleted_at = now()            (soft delete, ownership-guarded)
 *   2. revoke all unrevoked API keys          (ingestion dies at the door)
 *   3. deactivate all live endpoints          (fan-out / retries refuse them)
 *   4. cancel PENDING deliveries only         (status + completed_at, CHECK-safe)
 * processing deliveries are deliberately untouched: they may finish their
 * in-flight attempt; the worker's record-time rules and pre-send gate prevent
 * any further retries once the endpoints are inactive. events, deliveries and
 * delivery_attempts are never deleted — history is preserved (FR-47..49).
 */
export async function softDeleteProject(
  ownerId: string,
  projectId: string,
): Promise<ProjectDeletionSummary> {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.updateMany({
      where: { id: projectId, userId: ownerId, deletedAt: null },
      data: { deletedAt: now },
    });
    if (project.count === 0) {
      throw AppError.notFound('Project not found');
    }

    const apiKeys = await tx.apiKey.updateMany({
      where: { projectId, revokedAt: null },
      data: { revokedAt: now },
    });

    const endpoints = await tx.endpoint.updateMany({
      where: { projectId, deletedAt: null, isActive: true },
      data: { isActive: false },
    });

    const deliveries = await tx.delivery.updateMany({
      where: { projectId, status: 'pending' },
      data: { status: 'cancelled', completedAt: now, lastError: 'cancelled: project deleted' },
    });

    return {
      apiKeysRevoked: apiKeys.count,
      endpointsDeactivated: endpoints.count,
      pendingDeliveriesCancelled: deliveries.count,
    };
  });
}
