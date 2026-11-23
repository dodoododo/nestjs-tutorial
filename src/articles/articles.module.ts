import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { EmptyFavoriteInputPipe } from './pipes/empty-favorite-input.pipe';

@Module({
  imports: [AuthModule],
  controllers: [ArticlesController],
  providers: [ArticlesService, EmptyFavoriteInputPipe],
})
export class ArticlesModule {}
