import { IsOptional, Matches, MaxLength } from 'class-validator';

// A device is named by an id the install generates for itself and then keeps
// forever. It is not a secret — it only makes registration idempotent so an
// app relaunch does not create a new device row.
export class RegisterDeviceDto {
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, {
    message: 'clientId باید بین ۸ تا ۶۴ نویسه امن باشد',
  })
  clientId: string;

  // Shown in the user's own device list ("iPhone of Amir"). Free text, never
  // interpreted by the server.
  @IsOptional()
  @MaxLength(40, { message: 'برچسب دستگاه حداکثر ۴۰ نویسه است' })
  label?: string;
}
