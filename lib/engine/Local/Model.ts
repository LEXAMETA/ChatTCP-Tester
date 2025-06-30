import { db } from '@db';
import { Storage } from '@lib/enums/Storage';
import { Logger } from '@lib/state/Logger';
import { mmkvStorage } from '@lib/storage/MMKV';
import { AppDirectory, readableFileSize } from '@lib/utils/File';
import { initLlama } from 'cui-llama.rn';
import { model_data, ModelDataType } from 'db/schema';
import { eq } from 'drizzle-orm';
import { getDocumentAsync } from 'expo-document-picker';
import { copyAsync, deleteAsync, getInfoAsync, readDirectoryAsync } from 'expo-file-system';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { GGMLNameMap, GGMLType } from './GGML';
import { Platform } from 'react-native';

export type ModelData = Omit<ModelDataType, 'id' | 'create_date' | 'last_modified'> & { file_path: string };

export namespace Model {
    export const getModelList = async () => {
        return await readDirectoryAsync(AppDirectory.ModelPath);
    };

    export const deleteModelById = async (id: number) => {
        const modelInfo = await db.query.model_data.findFirst({ where: eq(model_data.id, id) });
        if (!modelInfo) return;
        if (modelInfo.file_path.startsWith(AppDirectory.ModelPath)) {
            await deleteModel(modelInfo.file);
        }
        await db.delete(model_data).where(eq(model_data.id, id));
    };

    export const importModel = async () => {
        const result = await getDocumentAsync({
            copyToCacheDirectory: false,
        });
        if (result.canceled || !result.assets[0]) return;
        const file = result.assets[0];
        const name = file.name as string;
        if (!name) {
            Logger.errorToast('Import Failed: File name is undefined');
            return;
        }
        const newdir = `${AppDirectory.ModelPath}${name}`;
        Logger.infoToast('Importing file...');
        try {
            await copyAsync({
                from: file.uri,
                to: newdir,
            });
        } catch (error) {
            Logger.errorToast(`Import Failed: ${String(error)}`);
            return;
        }
        if (await createModelData(name, true)) {
            Logger.infoToast('Model Imported Successfully!');
        }
    };

    export const linkModelExternal = async () => {
        const result = await getDocumentAsync({
            copyToCacheDirectory: false,
        });
        if (result.canceled || !result.assets[0]) return;
        const file = result.assets[0];
        Logger.infoToast('Importing file...');
        if (!file.name) {
            Logger.errorToast('Import Failed: File name is missing or invalid.');
            return;
        }
        const filename: string = file.name;
        if (await createModelDataExternal(file.uri, filename, true)) {
            Logger.infoToast('Model Imported Successfully!');
        }
    };

    export const createModelDataExternal = async (
        newdir: string,
        filename: string,
        deleteOnFailure: boolean = false
    ) => {
        if (!filename) {
            Logger.errorToast('Filename invalid, Import Failed');
            return false;
        }
        return setModelDataInternal(filename, newdir, deleteOnFailure);
    };

    export const verifyModelList = async () => {
        let modelList = await db.query.model_data.findMany();
        const fileList = await getModelList(); // fileList is string[]
        if (Platform.OS === 'android') {
            for (const item of modelList) {
                if (item.name === '' || !(await getInfoAsync(item.file_path)).exists) {
                    Logger.warnToast(`Model Missing, its entry will be deleted: ${item.name}`);
                    await db.delete(model_data).where(eq(model_data.id, item.id));
                }
            }
        }
        modelList = await db.query.model_data.findMany(); // Re-fetch updated list
        for (const item of fileList) {
            if (modelList.some(model => model.file === item)) continue;
            const filename: string = item;
            await createModelData(filename);
        }
    };

    export const createModelData = async (filename: string, deleteOnFailure: boolean = false) => {
        if (!filename) {
            Logger.errorToast('Filename invalid, Import Failed');
            return false;
        }
        return setModelDataInternal(filename, `${AppDirectory.ModelPath}${filename}`, deleteOnFailure);
    };

    export const getModelListQuery = () => {
        return db.query.model_data.findMany();
    };

    export const updateName = async (name: string, id: number) => {
        await db.update(model_data).set({ name }).where(eq(model_data.id, id));
    };

    export const isInitialEntry = (data: ModelData) => {
        const placeholderValues = {
            context_length: 0,
            name: 'N/A',
            file_size: 0,
            params: 'N/A',
            quantization: '-1',
            architecture: 'N/A'
        };

        return (
            data.context_length === placeholderValues.context_length &&
            data.name === placeholderValues.name &&
            data.file_size === placeholderValues.file_size &&
            data.params === placeholderValues.params &&
            data.quantization === placeholderValues.quantization &&
            data.architecture === placeholderValues.architecture
        );
    };

    const initialModelEntry = (filename: string, file_path: string): typeof model_data.$inferInsert => ({
        context_length: 0,
        file: filename,
        file_path,
        name: 'N/A',
        file_size: 0,
        params: 'N/A',
        quantization: '-1',
        architecture: 'N/A',
        create_date: Date.now(),
        last_modified: Date.now(),
    });

    const setModelDataInternal = async (
        filename: string,
        file_path: string,
        deleteOnFailure: boolean
    ) => {
        try {
            const [{ id }] = await db
                .insert(model_data)
                .values(initialModelEntry(filename, file_path))
                .returning({ id: model_data.id });

            const modelContext = await initLlama({ model: file_path, vocab_only: true });
            const modelInfo: any = modelContext.model;
            const modelType = modelInfo.metadata?.['general.architecture'];

            const updateData: Partial<typeof model_data.$inferInsert> = {
                context_length: Number(modelInfo.metadata?.[modelType + '.context_length'] ?? 0),
                name: modelInfo.metadata?.['general.name'] ?? 'N/A',
                file_size: Number(modelInfo.size ?? 0),
                params: modelInfo.metadata?.['general.size_label'] ?? 'N/A',
                quantization: String(modelInfo.metadata?.['general.file_type'] ?? '-1'),
                architecture: modelType ?? 'N/A',
                last_modified: Date.now(),
            };

            Logger.info(`New Model Data:\n${modelDataText({
                ...updateData,
                file: filename,
                file_path
            } as ModelData)}`);

            await modelContext.release();
            await db.update(model_data).set(updateData).where(eq(model_data.id, id));
            return true;
        } catch (e) {
            Logger.errorToast(`Failed to create data: ${String(e)}`);
            if (deleteOnFailure) await deleteAsync(file_path, { idempotent: true });
            return false;
        }
    };

    const modelDataText = (data: ModelData) => {
        const quantValue = parseInt(data.quantization, 10) as GGMLType;
        const quantType = GGMLNameMap[quantValue] ?? 'N/A';
        return `Context length: ${data.context_length ?? 'N/A'}\nFile: ${data.file}\nName: ${data.name ?? 'N/A'}\nSize: ${(data.file_size && readableFileSize(data.file_size)) ?? 'N/A'}\nParams: ${data.params ?? 'N/A'}\nQuantization: ${quantType}\nArchitecture: ${data.architecture ?? 'N/A'}`;
    };

    const modelExists = async (modelName: string) => {
        return (await getModelList()).includes(modelName);
    };

    const deleteModel = async (name: string) => {
        if (!(await modelExists(name))) return;
        return await deleteAsync(`${AppDirectory.ModelPath}${name}`);
    };

    // === KV namespace added below ===
    export namespace KV {
        export const useKVState = create<KVStateProps>()(
            persist(
                (set, get) => ({
                    kvCacheLoaded: false,
                    kvCacheTokens: [],
                    setKvCacheLoaded: (b: boolean) => {
                        set((state) => ({ ...state, kvCacheLoaded: b }));
                    },
                    setKvCacheTokens: (tokens: number[]) => {
                        set((state) => ({ ...state, kvCacheTokens: tokens }));
                    },
                    verifyKVCache: (tokens: number[]) => {
                        const cachedTokens = get().kvCacheTokens;
                        let matched = 0;
                        const [a, b] =
                            cachedTokens.length <= tokens.length
                                ? [cachedTokens, tokens]
                                : [tokens, cachedTokens];
                        a.forEach((v, i) => {
                            if (v === b[i]) matched++;
                        });
                        return {
                            match: matched === a.length,
                            cachedLength: cachedTokens.length,
                            inputLength: tokens.length,
                            matchLength: matched,
                        };
                    },
                }),
                {
                    name: Storage.KV,
                    partialize: (state) => ({
                        kvCacheTokens: state.kvCacheTokens,
                    }),
                    storage: createJSONStorage(() => mmkvStorage),
                    version: 1,
                }
            )
        );

        export const sessionFile = `${AppDirectory.SessionPath}llama-session.bin`;

        export const getKVSize = async () => {
            const data = await getInfoAsync(sessionFile);
            return data.exists ? data.size : 0;
        };

        export const deleteKV = async () => {
            if ((await getInfoAsync(sessionFile)).exists) {
                await deleteAsync(sessionFile);
            }
        };

        export const kvInfo = async () => {
            const data = await getInfoAsync(sessionFile);
            if (!data.exists) {
                Logger.warn('No KV Cache found');
                return;
            }
            Logger.info(`Size of KV cache: ${Math.floor(data.size * 0.000001)} MB`);
        };
    }
}
