import { action } from '@storybook/addon-actions';
import type { Meta, Story } from '@storybook/preact';
import type { ComponentProps } from 'preact';
import { Controller, useForm } from 'react-hook-form';

import { Form, PasswordInput, SelectInput, TextInput, FormField } from '..';
import { Button } from '../../Button';
import { ButtonGroup } from '../../ButtonGroup';

export default {
	title: 'Forms/HookFormExample',
	component: Form,
	args: {
		onSubmit: (event: Event) => {
			action('submit')(event);
		},
	},
	parameters: {
		layout: 'centered',
	},
} satisfies Meta<ComponentProps<typeof Form>>;

export const Default: Story<ComponentProps<typeof Form>> = (args) => {
	const {
		// register,
		handleSubmit,
		// watch,
		formState: { errors },
		control,
		reset,
	} = useForm();

	return (
		<Form onSubmit={handleSubmit(args.onSubmit)}>
			<FormField label='Text' description='Input field for plain text' error={errors?.text?.message?.toString()}>
				<Controller name='text' control={control} rules={{ required: true }} render={({ field }) => <TextInput field={field} />} />
			</FormField>
			<FormField label='Password' description='Input field for secret text' error={errors?.password?.message?.toString()}>
				<Controller name='password' control={control} rules={{ minLength: 3 }} render={({ field }) => <PasswordInput field={field} />} />
			</FormField>
			<FormField label='Select' description='Input field for secret text' error={errors?.options?.message?.toString()}>
				<Controller
					name='options'
					control={control}
					rules={{ required: true }}
					render={({ field }) => (
						<SelectInput
							options={[
								{ value: '1', label: 'Option 1' },
								{ value: '2', label: 'Option 2' },
								{ value: '3', label: 'Option 3' },
							]}
							field={field}
						/>
					)}
				/>
			</FormField>
			<ButtonGroup>
				<Button submit stack>
					Submit
				</Button>
				<Button onClick={() => reset()} nude secondary stack>
					Cancel
				</Button>
			</ButtonGroup>
		</Form>
	);
};
Default.storyName = 'default';
