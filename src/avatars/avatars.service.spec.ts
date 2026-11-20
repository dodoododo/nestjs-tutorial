import { Logger, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AuthService } from '../auth/auth.service';
import { User } from '../database/entities/user.entity';
import { Attachment } from '../database/entities/attachment.entity';
import { AvatarImageService } from './avatar-image.service';
import { AvatarStorageService } from './avatar-storage.service';
import { AVATAR_PUBLIC_PATH } from './avatar.constants';
import { AvatarsService } from './avatars.service';

describe('AvatarsService', () => {
  let service: AvatarsService;
  const oldFile = `${randomUUID()}.png`;
  const newFile = `${randomUUID()}.png`;
  const oldUrl = `${AVATAR_PUBLIC_PATH}/${oldFile}`;
  const newUrl = `${AVATAR_PUBLIC_PATH}/${newFile}`;
  const manager = {
    findOne: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const userReferences = { existsBy: jest.fn() };
  const attachmentReferences = { existsBy: jest.fn() };
  const dataSource = {
    transaction: jest.fn(),
    getRepository: (entity: unknown) =>
      entity === User ? userReferences : attachmentReferences,
  };
  const images = { validate: jest.fn() };
  const storage = {
    write: jest.fn(),
    remove: jest.fn(),
    fileNameFromUrl: (url: string | null) =>
      AvatarStorageService.prototype.fileNameFromUrl(url),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    manager.findOne.mockReset().mockResolvedValue({
      id: 'user-id',
      email: 'private@example.test',
      username: 'owner',
      bio: null,
      image: oldUrl,
      passwordHash: 'must-not-leak',
    });
    for (const method of [manager.insert, manager.update, manager.delete])
      method.mockReset().mockResolvedValue({});
    dataSource.transaction
      .mockReset()
      .mockImplementation((callback: (m: unknown) => unknown) =>
        callback(manager),
      );
    images.validate.mockReset().mockResolvedValue({
      buffer: Buffer.from('encoded'),
      mime: 'image/png',
      extension: 'png',
    });
    storage.write
      .mockReset()
      .mockResolvedValue({ fileName: newFile, url: newUrl });
    storage.remove.mockReset().mockResolvedValue(undefined);
    userReferences.existsBy.mockReset().mockResolvedValue(false);
    attachmentReferences.existsBy.mockReset().mockResolvedValue(false);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AvatarsService,
        { provide: DataSource, useValue: dataSource },
        { provide: AvatarImageService, useValue: images },
        { provide: AvatarStorageService, useValue: storage },
        {
          provide: AuthService,
          useValue: {
            getCurrentUser: (user: User, token: string) =>
              AuthService.prototype.getCurrentUser(user, token),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(AvatarsService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('locks the user, atomically replaces metadata/image, and cleans old files after commit', async () => {
    const order: string[] = [];
    dataSource.transaction.mockImplementation(
      async (callback: (m: unknown) => unknown) => {
        const result = await callback(manager);
        order.push('commit');
        return result;
      },
    );
    storage.remove.mockImplementation(() => {
      order.push('remove');
      return Promise.resolve();
    });
    const response = await service.upload(
      'user-id',
      'existing-token',
      undefined,
    );
    expect(manager.findOne).toHaveBeenCalledWith(User, {
      where: { id: 'user-id' },
      select: { id: true, email: true, username: true, bio: true, image: true },
      lock: { mode: 'pessimistic_write' },
    });
    expect(manager.insert).toHaveBeenCalledWith(Attachment, {
      attachableType: 'user',
      attachableId: 'user-id',
      url: newUrl,
      fileName: newFile,
      fileType: 'image/png',
      fileSize: '7',
    });
    expect(manager.update).toHaveBeenCalledWith(User, 'user-id', {
      image: newUrl,
    });
    expect(manager.delete).toHaveBeenCalledWith(Attachment, {
      attachableType: 'user',
      attachableId: 'user-id',
      url: oldUrl,
    });
    expect(response).toEqual({
      user: {
        email: 'private@example.test',
        username: 'owner',
        bio: null,
        image: newUrl,
        token: 'existing-token',
      },
    });
    expect(storage.remove).toHaveBeenCalledWith(oldFile);
    expect(order).toEqual(['commit', 'remove']);
  });

  it('cleans a new file after a rolled-back write without deleting the previous avatar', async () => {
    const error = new Error('Persistence failed');
    manager.update.mockRejectedValue(error);
    await expect(service.upload('user-id', 'token', undefined)).rejects.toBe(
      error,
    );
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith(newFile);
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('retains a file if a failed COMMIT acknowledgement may still have committed its reference', async () => {
    const error = new Error('Commit acknowledgement lost');
    dataSource.transaction.mockRejectedValue(error);
    userReferences.existsBy.mockResolvedValue(true);
    await expect(service.upload('user-id', 'token', undefined)).rejects.toBe(
      error,
    );
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it.each(['user', 'attachment'])(
    'retains an old avatar still referenced by another %s',
    async (type) => {
      (type === 'user'
        ? userReferences
        : attachmentReferences
      ).existsBy.mockResolvedValue(true);
      await service.upload('user-id', 'token', undefined);
      expect(storage.remove).not.toHaveBeenCalled();
    },
  );

  it('logs cleanup failures while keeping the committed avatar response successful', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    storage.remove.mockRejectedValue(new Error('Access denied'));
    const response = await service.upload('user-id', 'token', undefined);
    expect(response.user.image).toBe(newUrl);
    expect(warn).toHaveBeenCalledWith(`Avatar cleanup deferred: ${oldFile}`);
  });

  it('retains files and logs when reference checks are unavailable after rollback', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const error = new Error('Database unavailable');
    dataSource.transaction.mockRejectedValue(error);
    attachmentReferences.existsBy.mockRejectedValue(error);
    await expect(service.upload('user-id', 'token', undefined)).rejects.toBe(
      error,
    );
    expect(storage.remove).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(`Avatar cleanup deferred: ${newFile}`);
  });

  it('cleans up if the authenticated user was deleted before the row lock', async () => {
    manager.findOne.mockResolvedValue(null);
    await expect(service.upload('user-id', 'token', undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(storage.remove).toHaveBeenCalledWith(newFile);
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('does not write or begin a transaction when validation fails', async () => {
    const error = new Error('Invalid image');
    images.validate.mockRejectedValue(error);
    await expect(service.upload('user-id', 'token', undefined)).rejects.toBe(
      error,
    );
    expect(storage.write).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('does not change the database when file storage fails', async () => {
    storage.write.mockRejectedValue(new Error('Disk full'));
    await expect(service.upload('user-id', 'token', undefined)).rejects.toThrow(
      'Disk full',
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
