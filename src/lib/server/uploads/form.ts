/** The upload and edit forms' fields (routes/upload, routes/uploads/[id]), read into an UploadInput. */
import { IMAGE_MAX_BYTES, type UploadInput } from './uploads';

const text = (form: FormData, key: string) => {
	const v = form.get(key);
	return typeof v === 'string' ? v : '';
};

/**
 * The form's fields. A screenshot bigger than IMAGE_MAX_BYTES is refused without reading it; `image`
 * is then `too-big`. On an edit, the `image_action` radio says keep, remove or replace.
 */
export const readUploadForm = async (form: FormData, edit: boolean): Promise<UploadInput | { problem: string }> => {
	const file = form.get('image');
	const action = text(form, 'image_action');
	let image: UploadInput['image'] = edit ? 'keep' : null;
	if (edit && action === 'remove') image = 'remove';
	if (file instanceof File && file.size > 0 && (!edit || action === 'replace')) {
		if (file.size > IMAGE_MAX_BYTES) return { problem: `Screenshots are at most ${IMAGE_MAX_BYTES / 1024 / 1024} MB.` };
		image = new Uint8Array(await file.arrayBuffer());
	}
	return { title: text(form, 'title'), description: text(form, 'description'), blueprintString: text(form, 'string'), image };
};

/** What the form gets back to show again after a refusal: never the image, and the string only when it's small. */
export const formEcho = (form: FormData) => {
	const string = text(form, 'string');
	return { title: text(form, 'title'), description: text(form, 'description'), string: string.length <= 512 * 1024 ? string : '' };
};
