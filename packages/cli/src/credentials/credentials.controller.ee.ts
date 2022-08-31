/* eslint-disable import/no-cycle */
import express from 'express';
import { LoggerProxy } from 'n8n-workflow';
import { Db, ResponseHelper } from '..';
import type { CredentialsEntity } from '../databases/entities/CredentialsEntity';

import type { CredentialRequest } from '../requests';
import { EECredentialsService as EECredentials } from './credentials.service.ee';
import type { CredentialWithSharings } from './credentials.types';
import { isCredentialsSharingEnabled, rightDiff } from './helpers';

export const EECredentialsController = express.Router();

EECredentialsController.use((_req, _res, next) => {
	if (!isCredentialsSharingEnabled()) {
		// skip ee router and use free one
		next('router');
		return;
	}
	// use ee router
	next();
});

/**
 * GET /credentials
 */
EECredentialsController.get(
	'/',
	ResponseHelper.send(async (req: CredentialRequest.GetAll): Promise<CredentialWithSharings[]> => {
		try {
			const allCredentials = await EECredentials.getAll(req.user, {
				relations: ['shared', 'shared.role', 'shared.user'],
			});

			// eslint-disable-next-line @typescript-eslint/unbound-method
			return allCredentials.map(EECredentials.addOwnerAndSharings);
		} catch (error) {
			LoggerProxy.error('Request to list credentials failed', error as Error);
			throw error;
		}
	}),
);

/**
 * GET /credentials/:id
 */
EECredentialsController.get(
	'/:id',
	(req, _, next) => (req.params.id === 'new' ? next('router') : next()), // skip ee router and use free one for naming
	ResponseHelper.send(async (req: CredentialRequest.Get) => {
		const { id: credentialId } = req.params;
		const includeDecryptedData = req.query.includeData === 'true';

		if (Number.isNaN(Number(credentialId))) {
			throw new ResponseHelper.ResponseError(`Credential ID must be a number.`, undefined, 400);
		}

		let credential = (await EECredentials.get(
			{ id: credentialId },
			{ relations: ['shared', 'shared.role', 'shared.user'] },
		)) as CredentialsEntity & CredentialWithSharings;

		if (!credential) {
			throw new ResponseHelper.ResponseError(
				`Credential with ID "${credentialId}" could not be found.`,
				undefined,
				404,
			);
		}

		const userSharing = credential.shared?.find((shared) => shared.user.id === req.user.id);

		if (!userSharing && req.user.globalRole.name !== 'owner') {
			throw new ResponseHelper.ResponseError(`Forbidden.`, undefined, 403);
		}

		credential = EECredentials.addOwnerAndSharings(credential);

		// @ts-ignore @TODO_TECH_DEBT: Stringify `id` with entity field transformer
		credential.id = credential.id.toString();

		if (!includeDecryptedData || !userSharing || userSharing.role.name !== 'owner') {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { id, data: _, ...rest } = credential;

			// @TODO_TECH_DEBT: Stringify `id` with entity field transformer
			return { id: id.toString(), ...rest };
		}

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { id, data: _, ...rest } = credential;

		const key = await EECredentials.getEncryptionKey();
		const decryptedData = await EECredentials.decrypt(key, credential);

		// @TODO_TECH_DEBT: Stringify `id` with entity field transformer
		return { id: id.toString(), data: decryptedData, ...rest };
	}),
);

/**
 * (EE) POST /credentials/:id/share
 *
 * Grant or remove users' access to a credential.
 */

EECredentialsController.put('/:credentialId/share', async (req: CredentialRequest.Share, res) => {
	const { credentialId } = req.params;
	const { shareWithIds } = req.body;

	if (!Array.isArray(shareWithIds) || !shareWithIds.every((userId) => typeof userId === 'string')) {
		return res.status(400).send('Bad Request');
	}

	const { ownsCredential, credential } = await EECredentials.isOwned(req.user, credentialId);

	if (!ownsCredential || !credential) {
		return res.status(403).send();
	}

	await Db.transaction(async (trx) => {
		// remove all sharings that are not supposed to exist anymore
		await EECredentials.pruneSharings(trx, credentialId, [req.user.id, ...shareWithIds]);

		const sharings = await EECredentials.getSharings(trx, credentialId);

		// extract the new sharings that need to be added
		const newShareeIds = rightDiff(
			[sharings, (sharing) => sharing.userId],
			[shareWithIds, (shareeId) => shareeId],
		);

		if (newShareeIds.length) {
			await EECredentials.share(trx, credential, newShareeIds);
		}
	});

	return res.status(200).send();
});
