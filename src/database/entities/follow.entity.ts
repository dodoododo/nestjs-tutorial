import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from './user.entity';

@Entity('follows')
@Index('IDX_follows_follower_following_unique', ['followerId', 'followingId'], {
  unique: true,
})
@Index('IDX_follows_following_id', ['followingId'])
export class Follow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'follower_id', type: 'uuid' })
  followerId!: string;

  @Column({ name: 'following_id', type: 'uuid' })
  followingId!: string;

  @ManyToOne(() => User, {
    nullable: false,
    onDelete: 'CASCADE',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn({
    name: 'follower_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'FK_follows_follower_id',
  })
  follower!: User;

  @ManyToOne(() => User, {
    nullable: false,
    onDelete: 'CASCADE',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn({
    name: 'following_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'FK_follows_following_id',
  })
  following!: User;

  @CreateDateColumn({
    name: 'created_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
